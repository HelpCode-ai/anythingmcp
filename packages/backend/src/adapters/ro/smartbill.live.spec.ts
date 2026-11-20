import axios from 'axios';
import * as adapter from './smartbill.json';

/**
 * SmartBill Cloud API V1 adapter (https://ws.smartbill.ro/SBORO/api).
 *
 * HTTP Basic authentication with the account email and the API token; the
 * company CIF travels as the query parameter cif (reads, cancel, restore,
 * delete) or as companyVatCode in the JSON body (issuing), filled in from the
 * connector variable. Paths, parameters and required fields come from
 * SmartBill's published OpenAPI document,
 * https://api.smartbill.ro/en/smartbill-api-spec.yaml.
 *
 * Static checks always run. Live checks run only with RUN_SMARTBILL_LIVE=1:
 * without an account they confirm the API refuses wrong credentials with its
 * errorText; with SMARTBILL_EMAIL, SMARTBILL_API_TOKEN and SMARTBILL_CIF they
 * read the VAT rates and the document series. Reads only: no document is issued.
 *
 *   RUN_SMARTBILL_LIVE=1 SMARTBILL_EMAIL=... SMARTBILL_API_TOKEN=... SMARTBILL_CIF=... \
 *     npx jest src/adapters/ro/smartbill.live.spec.ts
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
  ['smartbill_list_series', 'GET', '/series'],
  ['smartbill_list_taxes', 'GET', '/tax'],
  ['smartbill_list_stocks', 'GET', '/stocks'],
  ['smartbill_create_invoice', 'POST', '/invoice/v2'],
  ['smartbill_create_invoice_from_estimate', 'POST', '/invoice/v2'],
  ['smartbill_get_invoice_payment_status', 'GET', '/invoice/paymentstatus'],
  ['smartbill_get_invoice_pdf', 'GET', '/invoice/pdf'],
  ['smartbill_send_document_email', 'POST', '/document/send'],
  ['smartbill_reverse_invoice', 'POST', '/invoice/reverse'],
  ['smartbill_cancel_invoice', 'PUT', '/invoice/cancel'],
  ['smartbill_restore_invoice', 'PUT', '/invoice/restore'],
  ['smartbill_delete_invoice', 'DELETE', '/invoice'],
  ['smartbill_create_estimate', 'POST', '/estimate/v2'],
  ['smartbill_get_estimate_invoices', 'GET', '/estimate/invoices'],
  ['smartbill_get_estimate_pdf', 'GET', '/estimate/pdf'],
  ['smartbill_cancel_estimate', 'PUT', '/estimate/cancel'],
  ['smartbill_restore_estimate', 'PUT', '/estimate/restore'],
  ['smartbill_delete_estimate', 'DELETE', '/estimate'],
  ['smartbill_register_payment', 'POST', '/payment'],
  ['smartbill_get_fiscal_receipt_text', 'GET', '/payment/text'],
  ['smartbill_delete_receipt', 'DELETE', '/payment/chitanta'],
  ['smartbill_delete_payment', 'DELETE', '/payment/v2'],
];
const REQUIRED: Record<string, string[]> = {
  smartbill_list_stocks: ['date'],
  smartbill_create_invoice: ['series_name', 'client', 'products'],
  smartbill_create_invoice_from_estimate: ['series_name', 'estimate_series_name', 'estimate_number'],
  smartbill_get_invoice_payment_status: ['series_name', 'number'],
  smartbill_get_invoice_pdf: ['series_name', 'number'],
  smartbill_send_document_email: ['type', 'series_name', 'number'],
  smartbill_reverse_invoice: ['series_name', 'number'],
  smartbill_cancel_invoice: ['series_name', 'number'],
  smartbill_restore_invoice: ['series_name', 'number'],
  smartbill_delete_invoice: ['series_name', 'number'],
  smartbill_create_estimate: ['series_name', 'client', 'products'],
  smartbill_get_estimate_invoices: ['series_name', 'number'],
  smartbill_get_estimate_pdf: ['series_name', 'number'],
  smartbill_cancel_estimate: ['series_name', 'number'],
  smartbill_restore_estimate: ['series_name', 'number'],
  smartbill_delete_estimate: ['series_name', 'number'],
  smartbill_register_payment: ['type'],
  smartbill_get_fiscal_receipt_text: ['id'],
  smartbill_delete_receipt: ['series_name', 'number'],
  smartbill_delete_payment: ['payment_type'],
};
const SWITCHED_OFF: string[] = ['smartbill_cancel_estimate', 'smartbill_cancel_invoice', 'smartbill_delete_estimate', 'smartbill_delete_invoice', 'smartbill_delete_payment', 'smartbill_delete_receipt', 'smartbill_register_payment', 'smartbill_restore_estimate', 'smartbill_restore_invoice', 'smartbill_reverse_invoice'];

describe('smartbill adapter: static contract', () => {
  it('is filed where the catalog expects it', () => {
    expect(a.slug).toBe('smartbill');
    expect(a.region).toBe('ro');
    expect(a.category).toBe('accounting');
    expect(a.icon).toBe('smartbill');
    expect(a.docsUrl).toBe('https://api.smartbill.ro/en/');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://ws.smartbill.ro/SBORO/api');
  });

  it('authenticates as the vendor documents', () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({
      'username': '{{SMARTBILL_EMAIL}}',
      'password': '{{SMARTBILL_API_TOKEN}}'
    });
    expect(a.requiredEnvVars).toEqual(['SMARTBILL_EMAIL', 'SMARTBILL_API_TOKEN', 'SMARTBILL_CIF']);
    expect(a.optionalEnvVars ?? []).toEqual([]);
    for (const name of [...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]) {
      expect(a.envVarMeta[name]?.label).toBeTruthy();
    }
    for (const name of ['SMARTBILL_API_TOKEN']) {
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
      expect(entry.name).toMatch(/^smartbill_[a-z0-9_]+$/);
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
      'tool': 'smartbill_list_taxes',
      'params': {}
    });
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
  });


  it('adds the company CIF to every call from the connector variable', () => {
    for (const entry of a.tools) {
      const m = entry.endpointMapping;
      if (m.method === 'POST') {
        expect([entry.name, m.bodyMapping?.companyVatCode]).toEqual([entry.name, '{{SMARTBILL_CIF}}']);
        expect(m.queryParams).toBeUndefined();
      } else {
        expect([entry.name, m.queryParams?.cif]).toEqual([entry.name, '{{SMARTBILL_CIF}}']);
        expect(m.bodyMapping).toBeUndefined();
      }
      expect(Object.keys(entry.parameters.properties ?? {})).not.toContain('cif');
      expect(m.path).not.toMatch(/^\/v3\//);
    }
    expect(new RegExp(a.envVarMeta.SMARTBILL_CIF.pattern!).test('RO12345678')).toBe(true);
    expect(new RegExp(a.envVarMeta.SMARTBILL_CIF.pattern!).test('12345678')).toBe(true);
    expect(new RegExp(a.envVarMeta.SMARTBILL_CIF.pattern!).test('RO 12 34')).toBe(false);
  });

  it('issues invoices and estimates as drafts unless told otherwise', () => {
    for (const name of ['smartbill_create_invoice', 'smartbill_create_invoice_from_estimate', 'smartbill_create_estimate']) {
      const entry = tool(name);
      expect(entry.enabled).not.toBe(false);
      expect(entry.parameters.properties?.is_draft).toMatchObject({ type: 'boolean', default: true });
      expect(entry.endpointMapping.bodyMapping).toMatchObject({ isDraft: '$is_draft', seriesName: '$series_name' });
    }
    expect(tool('smartbill_create_invoice').endpointMapping.bodyMapping).toMatchObject({
      client: '$client',
      products: '$products',
      sendEmail: '$send_email',
    });
    expect(tool('smartbill_create_invoice').parameters.properties?.send_email).toMatchObject({ default: false });
    expect(tool('smartbill_create_invoice_from_estimate').endpointMapping.bodyMapping).toMatchObject({
      useEstimateDetails: true,
      estimate: { seriesName: '$estimate_series_name', number: '$estimate_number' },
    });
  });

  it('addresses a document by series and number in the query', () => {
    for (const name of [
      'smartbill_get_invoice_payment_status',
      'smartbill_get_invoice_pdf',
      'smartbill_cancel_invoice',
      'smartbill_restore_invoice',
      'smartbill_delete_invoice',
      'smartbill_get_estimate_invoices',
      'smartbill_get_estimate_pdf',
      'smartbill_cancel_estimate',
      'smartbill_restore_estimate',
      'smartbill_delete_estimate',
      'smartbill_delete_receipt',
    ]) {
      expect([name, tool(name).endpointMapping.queryParams]).toEqual([
        name,
        { cif: '{{SMARTBILL_CIF}}', seriesname: '$series_name', number: '$number' },
      ]);
    }
  });

  it('asks for the PDF as a binary file, never with the JSON Accept header', () => {
    expect(a.connector.headers).toMatchObject({ Accept: 'application/json', 'Content-Type': 'application/json' });
    for (const name of ['smartbill_get_invoice_pdf', 'smartbill_get_estimate_pdf']) {
      expect(tool(name).endpointMapping.headers).toEqual({ Accept: 'application/octet-stream' });
    }
  });

  it('keeps reversal, cancellation, deletion and payment registration switched off', () => {
    for (const entry of a.tools) {
      const m = entry.endpointMapping;
      const risky = m.method === 'PUT' || m.method === 'DELETE' || m.path === '/invoice/reverse' || m.path === '/payment';
      expect([entry.name, entry.enabled === false]).toEqual([entry.name, risky]);
    }
    expect(JSON.stringify(tool('smartbill_register_payment').parameters.properties?.type?.enum)).not.toContain('Bon');
  });

  it('turns a populated errorText inside a 200 answer into a failed call', () => {
    expect(a.connector.config).toEqual({
      errorWhen: [
        { path: 'errorText', messagePath: 'errorText', messageMatches: 'Autentificare', status: 401 },
        { path: 'errorText', messagePath: 'errorText', status: 400 },
        { path: 'status.code', equals: 1, messagePath: 'status.message', status: 400 },
      ],
    });
  });
});


// Opt-in: RUN_SMARTBILL_LIVE=1. The refusal check needs no account; the reads
// need SMARTBILL_EMAIL, SMARTBILL_API_TOKEN and SMARTBILL_CIF. Nothing is issued.
const live = process.env.RUN_SMARTBILL_LIVE === '1';
(live ? describe : describe.skip)('smartbill: live', () => {
  it('refuses wrong credentials with 401 and an errorText', async () => {
    const response = await axios.get(`${a.connector.baseUrl}/tax`, {
      params: { cif: 'RO12345678' },
      auth: { username: 'nobody@example.org', password: 'not-a-token' },
      headers: { Accept: 'application/json' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(String(response.data.errorText)).toMatch(/Autentificare/);
  });

  it('reads the VAT rates and the document series of the company', async () => {
    const username = process.env.SMARTBILL_EMAIL;
    const password = process.env.SMARTBILL_API_TOKEN;
    const cif = process.env.SMARTBILL_CIF;
    if (!username || !password || !cif) {
      throw new Error('Set SMARTBILL_EMAIL, SMARTBILL_API_TOKEN and SMARTBILL_CIF for the live check');
    }
    const options = { params: { cif }, auth: { username, password }, headers: { Accept: 'application/json' }, validateStatus: () => true };
    const taxes = await axios.get(`${a.connector.baseUrl}/tax`, options);
    expect(taxes.status).toBe(200);
    expect(Array.isArray(taxes.data.taxes)).toBe(true);
    const series = await axios.get(`${a.connector.baseUrl}/series`, options);
    expect(series.status).toBe(200);
    expect(Array.isArray(series.data.list)).toBe(true);
  });
});
