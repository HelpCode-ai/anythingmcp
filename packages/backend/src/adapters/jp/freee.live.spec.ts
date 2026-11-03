import * as adapter from './freee.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * freee API (developer.freee.co.jp; OpenAPI files in github.com/freee/freee-api-schema:
 * v2020_06_15/open-api-3/api-schema.json for freee会計 and iv/open-api-3/api-schema.yml for
 * freee請求書): base https://api.freee.co.jp, accounting under /api/1, invoices and quotations
 * under /iv. OAuth2 authorization code at accounts.secure.freee.co.jp/public_api, client
 * credentials in the token request body, 6-hour access tokens and single-use refresh tokens.
 * Almost every call needs company_id.
 * Live part (reads only: me, companies, account items, taxes, walletables, deals, a trial P/L, invoices):
 *   FREEE_ACCESS_TOKEN=... RUN_FREEE_LIVE=1 npx jest src/adapters/jp/freee
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; maximum?: number }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string; advanced?: boolean }>;
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
const PREFIX = 'freee_';

describe('freee adapter: static spec conformance', () => {
  it('signs in with OAuth2 authorization code at accounts.secure.freee.co.jp, client secret in the body', () => {
    expect(a.slug).toBe('freee');
    expect(a.region).toBe('jp');
    expect(a.requiredEnvVars).toEqual(['FREEE_CLIENT_ID', 'FREEE_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['FREEE_REFRESH_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://api.freee.co.jp');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{FREEE_CLIENT_ID}}',
      clientSecret: '{{FREEE_CLIENT_SECRET}}',
      refreshToken: '{{FREEE_REFRESH_TOKEN}}',
      authorizationUrl: 'https://accounts.secure.freee.co.jp/public_api/authorize?prompt=select_company',
      tokenUrl: 'https://accounts.secure.freee.co.jp/public_api/token',
      tokenAuthMethod: 'client_secret_post',
      scopes: 'read write',
    });
    expect(a.envVarMeta?.FREEE_CLIENT_SECRET.secret).toBe(true);
    expect(a.envVarMeta?.FREEE_REFRESH_TOKEN.advanced).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/api/1/users/me');
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      expect(`${t.name}:${p.startsWith('/api/1/') || p.startsWith('/iv/')}`).toBe(`${t.name}:true`);
      // The deprecated accounting invoice endpoints are not used.
      expect(p.startsWith('/api/1/invoices')).toBe(false);
      expect(p.startsWith('/api/1/quotations')).toBe(false);
    }
  });

  it('every call but the user and company lists carries company_id, in the query for reads and the body for writes', () => {
    for (const t of a.tools) {
      if (['freee_get_me', 'freee_list_companies'].includes(t.name)) continue;
      expect(`${t.name}:${t.parameters?.required?.includes('company_id')}`).toBe(`${t.name}:true`);
      const m = t.endpointMapping;
      const inPath = m.path.includes('{company_id}');
      if (m.method === 'GET' || m.method === 'DELETE') expect(`${t.name}:${inPath || m.queryParams?.company_id === '$company_id'}`).toBe(`${t.name}:true`);
      else expect(`${t.name}:${(m.bodyMapping as Record<string, unknown>).company_id}`).toBe(`${t.name}:$company_id`);
    }
  });

  it('maps the accounting reads to the documented paths and filters', () => {
    expect(tool('freee_get_me').endpointMapping).toEqual({ method: 'GET', path: '/api/1/users/me', queryParams: { companies: 'true' } });
    expect(tool('freee_list_companies').endpointMapping).toEqual({ method: 'GET', path: '/api/1/companies' });
    expect(tool('freee_get_company').endpointMapping.path).toBe('/api/1/companies/{company_id}');
    expect(tool('freee_list_deals').endpointMapping.queryParams).toMatchObject({ type: '$type', status: '$status', partner_id: '$partner_id', start_issue_date: '$start_issue_date', end_issue_date: '$end_issue_date', accruals: '$accruals', offset: '$offset', limit: '$limit' });
    expect(tool('freee_list_deals').parameters?.properties?.limit.maximum).toBe(100);
    expect(tool('freee_get_deal').endpointMapping.path).toBe('/api/1/deals/{id}');
    expect(tool('freee_list_partners').endpointMapping).toMatchObject({ path: '/api/1/partners', queryParams: { keyword: '$keyword' } });
    expect(tool('freee_list_taxes').endpointMapping).toEqual({ method: 'GET', path: '/api/1/taxes/companies/{company_id}', queryParams: { display_category: '$display_category', available: '$available' } });
    expect(tool('freee_list_wallet_txns').endpointMapping.queryParams).toMatchObject({ walletable_type: '$walletable_type', walletable_id: '$walletable_id', entry_side: '$entry_side' });
    expect(tool('freee_list_manual_journals').parameters?.properties?.limit.maximum).toBe(500);
    expect(tool('freee_request_journals').endpointMapping).toMatchObject({ method: 'GET', path: '/api/1/journals', queryParams: { download_type: '$download_type', 'visible_tags[]': '$visible_tags' } });
    expect(tool('freee_get_journals_status').endpointMapping.path).toBe('/api/1/journals/reports/{id}/status');
    expect(tool('freee_download_journals').endpointMapping.path).toBe('/api/1/journals/reports/{id}/download');
    expect(tool('freee_list_receipts').parameters?.required).toEqual(['company_id', 'start_date', 'end_date']);
    expect(tool('freee_list_general_ledgers').endpointMapping.path).toBe('/api/1/reports/general_ledgers');
  });

  it('reads the trial balances through one report tool and the section comparison separately', () => {
    const tb = tool('freee_get_trial_balance');
    expect(tb.endpointMapping.path).toBe('/api/1/reports/{report}');
    expect(tb.parameters?.properties?.report.enum).toEqual(['trial_bs', 'trial_bs_two_years', 'trial_bs_three_years', 'trial_pl', 'trial_pl_two_years', 'trial_pl_three_years', 'trial_cr', 'trial_cr_two_years', 'trial_cr_three_years']);
    expect(tb.endpointMapping.queryParams).toMatchObject({ fiscal_year: '$fiscal_year', start_month: '$start_month', end_month: '$end_month', account_item_display_type: '$account_item_display_type', breakdown_display_type: '$breakdown_display_type', adjustment: '$adjustment' });
    expect(tool('freee_get_trial_pl_sections').endpointMapping).toMatchObject({ path: '/api/1/reports/trial_pl_sections', queryParams: { section_ids: '$section_ids' } });
  });

  it('maps the writes with the documented bodies', () => {
    expect(tool('freee_create_deal').endpointMapping).toMatchObject({ method: 'POST', path: '/api/1/deals', bodyMapping: { type: '$type', issue_date: '$issue_date', details: '$details', payments: '$payments' } });
    expect(tool('freee_update_deal').endpointMapping).toMatchObject({ method: 'PUT', path: '/api/1/deals/{id}', bodyMapping: { details: '$details' } });
    expect(tool('freee_create_deal_payment').endpointMapping).toMatchObject({ method: 'POST', path: '/api/1/deals/{id}/payments', bodyMapping: { date: '$date', from_walletable_type: '$from_walletable_type', from_walletable_id: '$from_walletable_id', amount: '$amount' } });
    expect(tool('freee_create_partner').endpointMapping).toMatchObject({ method: 'POST', path: '/api/1/partners', bodyMapping: { name: '$name', invoice_registration_number: '$invoice_registration_number', address_attributes: '$address_attributes' } });
    expect(tool('freee_update_partner').endpointMapping).toMatchObject({ method: 'PUT', path: '/api/1/partners/{id}', bodyMapping: { available: '$available' } });
    expect(tool('freee_create_manual_journal').endpointMapping).toMatchObject({ method: 'POST', path: '/api/1/manual_journals', bodyMapping: { issue_date: '$issue_date', adjustment: '$adjustment', details: '$details' } });
    expect(tool('freee_create_item').endpointMapping.path).toBe('/api/1/items');
    expect(tool('freee_create_section').endpointMapping.path).toBe('/api/1/sections');
    expect(tool('freee_create_tag').endpointMapping.path).toBe('/api/1/tags');
  });

  it('maps freee請求書 invoices and quotations under /iv', () => {
    expect(tool('freee_list_invoices').endpointMapping).toMatchObject({ method: 'GET', path: '/iv/invoices', queryParams: { partner_ids: '$partner_ids', payment_status: '$payment_status', start_billing_date: '$start_billing_date' } });
    expect(tool('freee_get_invoice').endpointMapping.path).toBe('/iv/invoices/{id}');
    expect(tool('freee_list_invoice_templates').endpointMapping.path).toBe('/iv/invoices/templates');
    const ci = tool('freee_create_invoice');
    expect(ci.endpointMapping).toMatchObject({ method: 'POST', path: '/iv/invoices', bodyMapping: { billing_date: '$billing_date', partner_title: '$partner_title', tax_entry_method: '$tax_entry_method', tax_fraction: '$tax_fraction', withholding_tax_entry_method: '$withholding_tax_entry_method', lines: '$lines' } });
    expect(ci.parameters?.required).toEqual(['company_id', 'billing_date', 'partner_title', 'tax_entry_method', 'tax_fraction', 'withholding_tax_entry_method', 'lines']);
    expect(tool('freee_cancel_invoice').endpointMapping).toEqual({ method: 'PUT', path: '/iv/invoices/{id}/cancel', bodyMapping: { company_id: '$company_id' } });
    expect(tool('freee_uncancel_invoice').endpointMapping).toEqual({ method: 'PUT', path: '/iv/invoices/{id}/uncancel', bodyMapping: { company_id: '$company_id' } });
    expect(tool('freee_list_quotations').endpointMapping.path).toBe('/iv/quotations');
    expect(tool('freee_get_quotation').endpointMapping.path).toBe('/iv/quotations/{id}');
    expect(tool('freee_create_quotation').endpointMapping).toMatchObject({ method: 'POST', path: '/iv/quotations', bodyMapping: { quotation_date: '$quotation_date', expiration_date: '$expiration_date', lines: '$lines' } });
  });

  it('keeps the user and company list of freee_get_me and drops the rest', () => {
    const out = applyResponseTransform(
      { user: { id: 1, email: 'x@example.com', display_name: 'X', first_name: 'A', last_name: 'B', companies: [{ id: 10, display_name: 'ACME', role: 'admin', use_custom_role: false, extra: 1 }] } },
      tool('freee_get_me').responseMapping as never,
    ).value;
    expect(out).toEqual({ user: { id: 1, email: 'x@example.com', display_name: 'X', companies: [{ id: 10, display_name: 'ACME', role: 'admin', use_custom_role: false }] } });
  });

  it('installs the two deletes switched off and marks every delete destructive', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual(['freee_delete_deal', 'freee_delete_manual_journal']);
    for (const t of a.tools) {
      if (t.endpointMapping.method === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}:${t.enabled}`).toBe(`${t.name}:true:false`);
      if (t.endpointMapping.method === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
    expect(a.instructions).toContain('**Switched off at install**: `freee_delete_deal` and `freee_delete_manual_journal`; they cannot be undone');
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
      for (const r of t.parameters?.required ?? []) expect(`${t.name}:${r}:${props.includes(r)}`).toBe(`${t.name}:${r}:true`);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = tool(a.probe.tool);
    expect(probe.endpointMapping.method).toBe('GET');
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_FREEE_LIVE === '1' && process.env.FREEE_ACCESS_TOKEN ? describe : describe.skip;
live('freee adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.FREEE_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads me, companies, masters, deals, a trial P/L and invoices of the first company', async () => {
    const me = (await get('/api/1/users/me?companies=true')) as { user: { companies: Array<{ id: number }> } };
    const cid = me.user.companies[0].id;
    expect(await get('/api/1/companies')).toHaveProperty('companies');
    expect(await get(`/api/1/account_items?company_id=${cid}`)).toHaveProperty('account_items');
    expect(await get(`/api/1/taxes/companies/${cid}`)).toHaveProperty('taxes');
    expect(await get(`/api/1/walletables?company_id=${cid}`)).toHaveProperty('walletables');
    expect(await get(`/api/1/deals?company_id=${cid}&limit=1`)).toHaveProperty('deals');
    expect(await get(`/api/1/reports/trial_pl?company_id=${cid}`)).toHaveProperty('trial_pl');
    expect(await get(`/iv/invoices?company_id=${cid}&limit=1`)).toHaveProperty('invoices');
  }, 60_000);
});
