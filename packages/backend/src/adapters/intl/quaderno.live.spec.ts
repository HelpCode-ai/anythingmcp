import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import * as adapter from './quaderno.json';
import { RestEngine } from '../../connectors/engines/rest.engine';
import { OAuth2TokenService } from '../../connectors/engines/oauth2-token.service';
import { LoginTokenService } from '../../connectors/engines/login-token.service';
import { deriveToolAnnotations } from '../../mcp-server/tool-annotations';
import { applySchemaDefaults } from '../../common/schema-defaults.util';
import { interpolateConnectorConfig, interpolateDeep } from '../../common/env-interpolation.util';
import { applyResponseTransform, validateTransform } from '../../connectors/response-transform.util';
import { attachResponseMeta } from '../../connectors/engines/response-headers.util';
import { describeAdapterEnvVars } from '../env-var-meta';

/**
 * Two layers of verification for the Quaderno adapter (API version 20241028):
 *
 *   1. Static: always runs. Pins HTTP Basic with the private key as user name
 *      and an empty password, the pinned api_version in the Accept header, the
 *      account host, and every tool's method, URL, query and body through the
 *      real RestEngine. Checked on 15 Oct 2026 against Quaderno's OpenAPI
 *      document (developers.quaderno.io/redocusaurus/openapi-v20241028.yaml)
 *      and their official Ruby gem (quaderno-ruby: Basic auth, Accept
 *      `application/json; api_version=N`, GET .../deliver).
 *
 *   2. Live: skipped unless RUN_QUADERNO_LIVE=1. It checks that every route
 *      exists: 401 with a made-up key, while a made-up route answers 404
 *      without credentials (with a refused key Quaderno answers 500 there).
 *      With QUADERNO_ACCOUNT_NAME and QUADERNO_API_KEY it also runs every read
 *      on that account. RUN_QUADERNO_LIVE_WRITES=1 adds a contact, an invoice
 *      and a report request, and runs ONLY against the Sandbox
 *      (<account>.sandbox-quadernoapp.com) because invoices are legal tax
 *      documents that cannot be deleted; nothing is ever emailed:
 *
 *        RUN_QUADERNO_LIVE=1 QUADERNO_ACCOUNT_NAME=... QUADERNO_API_KEY=sk_... \
 *          npx jest src/adapters/intl/quaderno.live.spec.ts
 */

jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const mocked = jest.fn();
  return {
    __esModule: true,
    default: Object.assign(mocked, actual.default, { __actual: actual.default }),
    AxiosError: actual.AxiosError,
  };
});
const mockedAxios = axios as unknown as jest.Mock & { __actual: typeof axios };

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; default?: unknown }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: Record<string, unknown>; exposeHeaders?: string[] };
  responseMapping?: Record<string, any>;
  annotations?: Record<string, unknown>;
};
const a = adapter as unknown as {
  slug: string;
  unlisted?: boolean;
  category: string;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { pattern?: string; kind?: string; secret?: boolean }>;
  verifyHints: Record<string, string>;
  probe: { tool: string; params: Record<string, unknown> };
  connector: { baseUrl: string; authType: string; authConfig: Record<string, string>; headers: Record<string, string>; healthcheckPath: string };
  tools: Tool[];
};
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === name);
  if (!t) throw new Error(`missing tool ${name}`);
  return t;
};
const annotationsOf = (t: Tool) =>
  deriveToolAnnotations({ name: t.name, connectorType: 'REST', endpointMapping: t.endpointMapping, annotations: t.annotations });

const ACCOUNT = 'acme-1234';
const HOST = `https://${ACCOUNT}.quadernoapp.com/api`;
// Built at run time so no literal looks like a real credential.
const FAKE_KEY = ['sk', 'test', '0'.repeat(24)].join('_');
const ENV: Record<string, string> = { QUADERNO_ACCOUNT_NAME: ACCOUNT, QUADERNO_API_KEY: FAKE_KEY };

// Mirrors DynamicMcpTools; `baseUrl` lets the write test aim at the Sandbox.
const call = async (name: string, params: Record<string, unknown>, env = ENV, baseUrl = a.connector.baseUrl): Promise<any> => {
  const { config, endpointMapping } = interpolateConnectorConfig({ baseUrl, headers: a.connector.headers }, tool(name).endpointMapping, env);
  const { body, headers } = await new RestEngine({} as OAuth2TokenService, {} as LoginTokenService).executeWithMeta(
    {
      baseUrl: config.baseUrl,
      authType: a.connector.authType,
      authConfig: interpolateDeep(a.connector.authConfig, env),
      headers: config.headers,
    } as any,
    endpointMapping,
    { ...applySchemaDefaults(tool(name).parameters as any, params), ...env },
  );
  const wanted = tool(name).endpointMapping.exposeHeaders;
  return wanted?.length ? attachResponseMeta(body, { headers }, tool(name).endpointMapping.queryParams) : body;
};
const shape = (name: string, raw: unknown) => applyResponseTransform(raw, tool(name).responseMapping as any).value as any;
const sent = () => mockedAxios.mock.calls[0][0];
const query = () => new URLSearchParams(sent().paramsSerializer(sent().params));

const table: Array<[string, Record<string, unknown>, string, string]> = [
  ['quaderno_ping', {}, 'GET', '/ping'],
  ['quaderno_list_contacts', { q: 'Acme' }, 'GET', '/contacts'],
  ['quaderno_get_contact', { contact_id: 42 }, 'GET', '/contacts/42'],
  ['quaderno_create_contact', { first_name: 'Acme GmbH', kind: 'company' }, 'POST', '/contacts'],
  ['quaderno_delete_contact', { contact_id: 42 }, 'DELETE', '/contacts/42'],
  ['quaderno_list_invoices', {}, 'GET', '/invoices'],
  ['quaderno_get_invoice', { invoice_id: 7 }, 'GET', '/invoices/7'],
  ['quaderno_create_invoice', { contact: { id: 42 }, items: [{ description: 'Consulting', quantity: 1, unit_price: 100 }] }, 'POST', '/invoices'],
  ['quaderno_deliver_invoice', { invoice_id: 7 }, 'GET', '/invoices/7/deliver'],
  ['quaderno_list_credit_notes', {}, 'GET', '/credits'],
  ['quaderno_get_credit_note', { credit_note_id: 8 }, 'GET', '/credits/8'],
  ['quaderno_list_quotes', {}, 'GET', '/proformas'],
  ['quaderno_get_quote', { quote_id: 9 }, 'GET', '/proformas/9'],
  ['quaderno_list_expenses', {}, 'GET', '/expenses'],
  ['quaderno_list_products', {}, 'GET', '/items'],
  ['quaderno_calculate_tax', { to_country: 'DE' }, 'GET', '/tax_rates/calculate'],
  ['quaderno_validate_tax_id', { country: 'DE', tax_id: 'DE123456789' }, 'GET', '/tax_ids/validate'],
  ['quaderno_list_tax_jurisdictions', {}, 'GET', '/jurisdictions'],
  ['quaderno_list_tax_codes', {}, 'GET', '/tax_codes'],
  ['quaderno_list_reports', {}, 'GET', '/reporting/requests'],
  ['quaderno_request_report', { report_type: 'tax_summary', from_date: '2026-07-01', to_date: '2026-09-30' }, 'POST', '/reporting/requests'],
  ['quaderno_get_report', { report_id: 5 }, 'GET', '/reporting/requests/5'],
];
const WRITES = ['quaderno_create_contact', 'quaderno_create_invoice', 'quaderno_deliver_invoice', 'quaderno_request_report'];
const OFF = ['quaderno_delete_contact'];

describe('quaderno adapter: static spec conformance', () => {
  beforeEach(() => mockedAxios.mockReset());

  it('is listed: checked against the vendor API spec and SDK on 15 Oct 2026', () => {
    expect(a.unlisted).toBeFalsy();
    expect(a.category).toBe('accounting');
    expect(a.icon).toBe('quaderno');
  });

  it('calls the account host with the private key as Basic user name and pins API version 20241028', () => {
    expect(a.connector.baseUrl).toBe('https://{{QUADERNO_ACCOUNT_NAME}}.quadernoapp.com/api');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{QUADERNO_API_KEY}}', password: '' });
    expect(a.connector.headers.Accept).toBe('application/json; api_version=20241028');
    // The probe and healthcheck list one contact: unlike /ping that also
    // proves the key belongs to QUADERNO_ACCOUNT_NAME.
    expect(a.connector.healthcheckPath).toBe('/contacts?limit=1');
    expect(a.probe).toEqual({ tool: 'quaderno_list_contacts', params: { limit: 1 } });
    expect(a.requiredEnvVars).toEqual(['QUADERNO_ACCOUNT_NAME', 'QUADERNO_API_KEY']);
    const meta = Object.fromEntries(describeAdapterEnvVars(a as never).map((m) => [m.name, m]));
    expect(meta.QUADERNO_API_KEY).toMatchObject({ kind: 'credential', secret: true, required: true });
    expect(meta.QUADERNO_ACCOUNT_NAME).toMatchObject({ kind: 'address', secret: false, required: true });
    const key = new RegExp(a.envVarMeta.QUADERNO_API_KEY.pattern!);
    expect(key.test(FAKE_KEY)).toBe(true);
    for (const bad of ['', 'pk_1111111111111111', 'sk_ 123']) expect(key.test(bad)).toBe(false);
    const account = new RegExp(a.envVarMeta.QUADERNO_ACCOUNT_NAME.pattern!);
    for (const good of [ACCOUNT, 'nippur-999']) expect(account.test(good)).toBe(true);
    for (const bad of ['https://acme.quadernoapp.com', 'acme.quadernoapp.com', '']) expect(account.test(bad)).toBe(false);
    for (const k of ['401', '404', '429']) expect(a.verifyHints[k]).toBeTruthy();
  });

  it('prefixes every tool with quaderno_ and shares no tool name with another adapter file', () => {
    const mine = new Set(a.tools.map((t) => t.name));
    expect(mine.size).toBe(a.tools.length);
    for (const name of mine) expect(name).toMatch(/^quaderno_[a-z_]+$/);
    const root = path.join(__dirname, '..');
    for (const region of fs.readdirSync(root).filter((d) => fs.statSync(path.join(root, d)).isDirectory())) {
      for (const file of fs.readdirSync(path.join(root, region)).filter((f) => f.endsWith('.json') && f !== 'quaderno.json')) {
        const other = JSON.parse(fs.readFileSync(path.join(root, region, file), 'utf8'));
        for (const t of other.tools ?? []) expect(`${file}:${mine.has(t.name)}`).toBe(`${file}:false`);
      }
    }
  });

  it('asks for confirmation on every write, installs the delete switched off and marks the rest read-only', () => {
    for (const name of [...WRITES, ...OFF]) {
      expect(tool(name).description).toMatch(/confirm with the user first/);
      expect(`${name}:${annotationsOf(tool(name)).readOnlyHint}`).toBe(`${name}:false`);
    }
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name)).toEqual(OFF);
    // Delivering is a GET that emails the customer: never read-only.
    expect(annotationsOf(tool('quaderno_deliver_invoice'))).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(tool('quaderno_deliver_invoice').description).toMatch(/cannot be unsent/);
    expect(tool('quaderno_create_invoice').description).toMatch(/cannot be deleted/);
    for (const t of a.tools.filter((x) => ![...WRITES, ...OFF].includes(x.name))) {
      expect(`${t.name}:${t.endpointMapping.method}:${annotationsOf(t).readOnlyHint}`).toBe(`${t.name}:GET:true`);
      expect(t.description).toMatch(/Read-only\./);
    }
  });

  it('explains sensitivity, setup, amounts and paging, names only real tools and writes no em dashes', () => {
    const names = new Set(a.tools.map((t) => t.name));
    const mentioned = [
      ...a.instructions.matchAll(/\bquaderno_[a-z_]+/g),
      ...a.tools.flatMap((t) => [...t.description.matchAll(/\bquaderno_[a-z_]+/g)]),
      ...a.tools.flatMap((t) => Object.values(t.parameters.properties ?? {}).flatMap((p) => [...String(p.description).matchAll(/\bquaderno_[a-z_]+/g)])),
    ].map((m) => m[0]);
    for (const name of mentioned) expect(names).toContain(name);
    for (const name of names) expect(a.instructions).toContain(`\`${name}\``);
    expect(a.instructions).toMatch(/Tax and customer data are sensitive/);
    expect(a.instructions).toMatch(/Writes need a yes/);
    expect(a.instructions).toMatch(/users\/api-keys/);
    expect(a.instructions).toMatch(/_cents/);
    expect(a.instructions).toMatch(/created_before/);
    expect(a.instructions).toMatch(/Out of scope/);
    for (const t of a.tools) {
      expect(t.description.length).toBeGreaterThanOrEqual(60);
      for (const [p, schema] of Object.entries(t.parameters.properties ?? {})) {
        expect(`${t.name}.${p}:${typeof schema.description}`).toBe(`${t.name}.${p}:string`);
      }
    }
    expect(JSON.stringify(adapter)).not.toMatch(/[\u2013\u2014]/);
  });

  it('gives every tool a valid response mapping that does real work', () => {
    for (const t of a.tools) {
      const tr = t.responseMapping?.transform;
      expect(`${t.name}:${!!tr}`).toBe(`${t.name}:true`);
      expect(validateTransform(tr)).toBeNull();
      expect(tr.select ?? tr.exclude ?? tr.include ?? tr.expression).toBeDefined();
      expect(tr.maxBytes).toBeGreaterThan(0);
    }
  });

  it('lists every tool in the URL table', () => {
    expect(table.map(([name]) => name).sort()).toEqual(a.tools.map((t) => t.name).sort());
  });

  it.each(table)('%s sends %s to the right URL with Basic auth and the pinned version', async (name, params, method, p) => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call(name, params);
    expect(mockedAxios).toHaveBeenCalledTimes(1);
    const req = sent();
    expect(req.method).toBe(method);
    expect(req.url).toBe(`${HOST}${p}`);
    expect(req.auth).toEqual({ username: FAKE_KEY, password: '' });
    expect(req.headers.Accept).toBe('application/json; api_version=20241028');
  });

  it('builds the contact, invoice and report bodies like the API documents them', async () => {
    mockedAxios.mockResolvedValue({ data: {}, headers: {} });
    await call('quaderno_create_contact', { kind: 'company', first_name: 'Acme GmbH', country: 'DE', tax_id: 'DE123456789', email: 'billing@acme.example' });
    expect(sent().data).toEqual({ kind: 'company', first_name: 'Acme GmbH', country: 'DE', tax_id: 'DE123456789', email: 'billing@acme.example' });
    mockedAxios.mockClear();
    const items = [{ description: 'Consulting', quantity: 2, unit_price: 150, tax_1_name: 'VAT', tax_1_rate: 19, tax_1_country: 'DE' }];
    await call('quaderno_create_invoice', { contact: { id: 42 }, items, currency: 'EUR', due_date: '2026-11-15', po_number: 'PO-7' });
    expect(sent().data).toEqual({ contact: { id: 42 }, items, currency: 'EUR', due_date: '2026-11-15', po_number: 'PO-7' });
    mockedAxios.mockClear();
    await call('quaderno_request_report', { report_type: 'tax_summary', from_date: '2026-07-01', to_date: '2026-09-30' });
    expect(sent().data).toEqual({ report_type: 'tax_summary', parameters: { from_date: '2026-07-01', to_date: '2026-09-30' } });
  });

  it('maps the filters and paging to Quaderno query names', async () => {
    mockedAxios.mockResolvedValue({ data: [], headers: {} });
    await call('quaderno_list_invoices', { q: 'INV-2026', date: '2026-01-01,2026-03-31', state: 'late', contact: 42, created_before: 1001 });
    expect(Object.fromEntries(query())).toEqual({ q: 'INV-2026', date: '2026-01-01,2026-03-31', state: 'late', contact: '42', limit: '25', created_before: '1001' });
    mockedAxios.mockClear();
    await call('quaderno_calculate_tax', { to_country: 'US', to_postal_code: '94010', to_city: 'Burlingame', tax_code: 'saas', amount: 99.9, tax_behavior: 'exclusive' });
    expect(Object.fromEntries(query())).toEqual({ to_country: 'US', to_postal_code: '94010', to_city: 'Burlingame', tax_code: 'saas', amount: '99.9', tax_behavior: 'exclusive' });
    mockedAxios.mockClear();
    await call('quaderno_validate_tax_id', { country: 'DE', tax_id: 'DE123456789' });
    expect(Object.fromEntries(query())).toEqual({ country: 'DE', tax_id: 'DE123456789' });
  });

  it('passes the paging headers on to the model', async () => {
    mockedAxios.mockResolvedValue({
      data: [{ id: 1001, number: '0042', state: 'paid', total_cents: 11900, contact: { id: 42, full_name: 'Acme GmbH' }, items: [{ description: 'x' }] }],
      headers: { 'x-pages-hasmore': 'true', 'x-pages-nextpage': `${HOST}/invoices?created_before=1001` },
    });
    const raw = await call('quaderno_list_invoices', {});
    expect(raw._headers['x-pages-hasmore']).toBe('true');
    expect(shape('quaderno_list_invoices', raw.data)).toEqual({
      invoices: [{ id: 1001, number: '0042', state: 'paid', total_cents: 11900, contact: { id: 42, full_name: 'Acme GmbH' } }],
    });
  });

  it('shapes a tax calculation and an invoice', () => {
    expect(
      shape('quaderno_calculate_tax', { name: 'VAT', rate: 19.0, taxable_part: 100.0, country: 'DE', tax_code: 'saas', tax_amount: 19.0, subtotal: 100.0, total_amount: 119.0, status: 'taxable', notes: null, region: null }),
    ).toEqual({ name: 'VAT', rate: 19.0, taxable_part: 100.0, country: 'DE', region: null, tax_code: 'saas', tax_amount: 19.0, subtotal: 100.0, total_amount: 119.0, status: 'taxable' });
    const invoice = shape('quaderno_get_invoice', {
      id: 7,
      number: '0042',
      state: 'outstanding',
      currency: 'EUR',
      total_cents: 11900,
      contact: { id: 42, full_name: 'Acme GmbH' },
      items: [{ id: 1, description: 'Consulting', quantity: 1, unit_price: 100, subtotal_cents: 10000, tax_1_name: 'VAT', tax_1_rate: 19 }],
      taxes: [{ label: 'VAT 19%', rate: 19, country: 'DE', amount_cents: 1900 }],
      evidence: { billing_country: 'DE', ip_address: '203.0.113.7' },
      custom_metadata: { internal: 'x' },
      payment_processor_id: 'ch_123',
      pdf: 'https://acme-1234.quadernoapp.com/invoice/abc.pdf',
    });
    expect(invoice.items).toEqual([{ description: 'Consulting', quantity: 1, unit_price: 100, subtotal_cents: 10000, tax_1_name: 'VAT', tax_1_rate: 19 }]);
    expect(invoice.taxes[0].amount_cents).toBe(1900);
    // The customer's IP address and location evidence stay out of the model's context.
    expect(invoice.evidence).toBeUndefined();
    expect(JSON.stringify(invoice)).not.toContain('203.0.113.7');
  });
});

const live = process.env.RUN_QUADERNO_LIVE === '1' ? describe : describe.skip;
live('quaderno adapter: live', () => {
  const real = !!(process.env.QUADERNO_ACCOUNT_NAME && process.env.QUADERNO_API_KEY);
  const writes = real && process.env.RUN_QUADERNO_LIVE_WRITES === '1';
  const env = () => ({ QUADERNO_ACCOUNT_NAME: process.env.QUADERNO_ACCOUNT_NAME!, QUADERNO_API_KEY: process.env.QUADERNO_API_KEY! });
  const probeEnv = { QUADERNO_ACCOUNT_NAME: process.env.QUADERNO_ACCOUNT_NAME ?? 'anythingmcp-probe', QUADERNO_API_KEY: FAKE_KEY };
  beforeAll(() => mockedAxios.mockImplementation((cfg: any) => (mockedAxios.__actual as any).request(cfg)));
  afterAll(() => mockedAxios.mockReset());

  it.each(table)('%s reaches a real route and is refused with a made-up key (401)', async (name, params) => {
    await expect(call(name, params, probeEnv)).rejects.toMatchObject({ response: { status: 401 } });
  }, 30000);

  it('answers a made-up route with 404 without credentials, which makes the 401s above meaningful', async () => {
    await expect(
      (mockedAxios.__actual as any).request({ method: 'GET', url: `https://${probeEnv.QUADERNO_ACCOUNT_NAME}.quadernoapp.com/api/no-such-route` }),
    ).rejects.toMatchObject({ response: { status: 404 } });
  }, 30000);

  (real ? it : it.skip)('runs every read on the account', async () => {
    const run = async (name: string, params: Record<string, unknown> = {}) => {
      const raw = await call(name, params, env());
      return shape(name, raw && raw._headers ? raw.data ?? raw : raw);
    };
    expect((await run('quaderno_ping')).status).toBeTruthy();
    const contacts = await run('quaderno_list_contacts', { limit: 2 });
    if (contacts.contacts[0]) expect((await run('quaderno_get_contact', { contact_id: contacts.contacts[0].id })).id).toBe(contacts.contacts[0].id);
    const invoices = await run('quaderno_list_invoices', { limit: 2 });
    if (invoices.invoices[0]) expect((await run('quaderno_get_invoice', { invoice_id: invoices.invoices[0].id })).id).toBe(invoices.invoices[0].id);
    const credits = await run('quaderno_list_credit_notes', { limit: 2 });
    if (credits.credit_notes[0]) await run('quaderno_get_credit_note', { credit_note_id: credits.credit_notes[0].id });
    const quotes = await run('quaderno_list_quotes', { limit: 2 });
    if (quotes.quotes[0]) await run('quaderno_get_quote', { quote_id: quotes.quotes[0].id });
    await run('quaderno_list_expenses', { limit: 2 });
    await run('quaderno_list_products', { limit: 2 });
    const tax = await run('quaderno_calculate_tax', { to_country: 'DE', tax_code: 'eservice', amount: 100 });
    expect(typeof tax.rate).toBe('number');
    const vat = await run('quaderno_validate_tax_id', { country: 'DE', tax_id: 'DE000000000' });
    expect([true, false, null]).toContain(vat.valid);
    expect((await run('quaderno_list_tax_jurisdictions', { country: 'DE' })).jurisdictions.length).toBeGreaterThan(0);
    expect((await run('quaderno_list_tax_codes')).tax_codes.length).toBeGreaterThan(0);
    await run('quaderno_list_reports');
  }, 120000);

  (writes ? it : it.skip)('creates a contact, an invoice and a report request in the Sandbox (never emails)', async () => {
    const sandbox = 'https://{{QUADERNO_ACCOUNT_NAME}}.sandbox-quadernoapp.com/api';
    const run = async (name: string, params: Record<string, unknown>) => shape(name, await call(name, params, env(), sandbox));
    const contact = await run('quaderno_create_contact', { kind: 'company', first_name: 'AnythingMCP live test', country: 'DE', email: 'test@example.com' });
    expect(contact.id).toBeTruthy();
    const invoice = await run('quaderno_create_invoice', { contact: { id: contact.id }, items: [{ description: 'Live test', quantity: 1, unit_price: 1 }], currency: 'EUR' });
    expect(invoice.contact.id).toBe(contact.id);
    const report = await run('quaderno_request_report', { report_type: 'invoices_list', from_date: '2026-01-01', to_date: '2026-01-31' });
    expect(report.id).toBeTruthy();
    expect((await run('quaderno_get_report', { report_id: report.id })).id).toBe(report.id);
  }, 120000);
});
