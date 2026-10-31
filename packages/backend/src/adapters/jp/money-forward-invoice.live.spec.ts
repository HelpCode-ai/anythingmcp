import * as adapter from './money-forward-invoice.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * Money Forward Cloud Invoice API v3 (invoice.moneyforward.com/docs/api/v3, OpenAPI 3.6.0
 * "Money Forward Invoice API"): base https://invoice.moneyforward.com/api/v3, OAuth2
 * authorization code through the Money Forward App Portal (api.biz.moneyforward.com/authorize
 * and /token), scopes mfc/invoice/data.read and mfc/invoice/data.write, client authentication
 * CLIENT_SECRET_BASIC. Lists return data plus pagination (page, per_page).
 * Live part (reads only: office, partners, items, billings, quotes, sent histories):
 *   MONEY_FORWARD_ACCESS_TOKEN=... RUN_MONEY_FORWARD_INVOICE_LIVE=1 npx jest src/adapters/jp/money-forward-invoice
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
const PREFIX = 'money_forward_invoice_';
const tool = (name: string) => {
  const t = a.tools.find((x) => x.name === PREFIX + name);
  if (!t) throw new Error(`missing tool ${PREFIX}${name}`);
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

describe('money-forward-invoice adapter: static spec conformance', () => {
  it('signs in through the Money Forward App Portal with Basic client auth and the invoice scopes', () => {
    expect(a.slug).toBe('money-forward-invoice');
    expect(a.region).toBe('jp');
    expect(a.requiredEnvVars).toEqual(['MONEY_FORWARD_CLIENT_ID', 'MONEY_FORWARD_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['MONEY_FORWARD_REFRESH_TOKEN']);
    expect(a.connector.baseUrl).toBe('https://invoice.moneyforward.com/api/v3');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      clientId: '{{MONEY_FORWARD_CLIENT_ID}}',
      clientSecret: '{{MONEY_FORWARD_CLIENT_SECRET}}',
      refreshToken: '{{MONEY_FORWARD_REFRESH_TOKEN}}',
      authorizationUrl: 'https://api.biz.moneyforward.com/authorize',
      tokenUrl: 'https://api.biz.moneyforward.com/token',
      tokenAuthMethod: 'client_secret_basic',
      scopes: 'mfc/invoice/data.read mfc/invoice/data.write',
    });
    expect(a.envVarMeta?.MONEY_FORWARD_CLIENT_SECRET.secret).toBe(true);
    expect(a.envVarMeta?.MONEY_FORWARD_REFRESH_TOKEN.advanced).toBe(true);
    expect(a.connector.healthcheckPath).toBe('/office');
    for (const t of a.tools) expect(t.endpointMapping.path.startsWith('/api/v3')).toBe(false);
  });

  it('maps office, partners, departments and items to the documented paths', () => {
    expect(tool('get_office').endpointMapping).toEqual({ method: 'GET', path: '/office' });
    expect(tool('list_partners').endpointMapping).toEqual({ method: 'GET', path: '/partners', queryParams: { name: '$name', code: '$code', name_kana: '$name_kana', partner_pic: '$partner_pic', office_pic: '$office_pic', page: '$page', per_page: '$per_page' } });
    expect(tool('get_partner').endpointMapping.path).toBe('/partners/{partner_id}');
    expect(tool('create_partner').endpointMapping).toMatchObject({ method: 'POST', path: '/partners', bodyMapping: { name: '$name', departments: '$departments', payment_deadline_setting: '$payment_deadline_setting' } });
    expect(tool('update_partner').endpointMapping).toMatchObject({ method: 'PUT', path: '/partners/{partner_id}' });
    expect(tool('list_partner_departments').endpointMapping.path).toBe('/partners/{partner_id}/departments');
    expect(tool('get_partner_department').endpointMapping.path).toBe('/partners/{partner_id}/departments/{department_id}');
    expect(tool('create_partner_department').endpointMapping).toMatchObject({ method: 'POST', path: '/partners/{partner_id}/departments', bodyMapping: { email: '$email', cc_emails: '$cc_emails', person_name: '$person_name' } });
    expect(tool('update_partner_department').endpointMapping).toMatchObject({ method: 'PUT', path: '/partners/{partner_id}/departments/{department_id}' });
    expect(tool('list_items').endpointMapping).toEqual({ method: 'GET', path: '/items', queryParams: { name: '$name', code: '$code', page: '$page', per_page: '$per_page' } });
    expect(tool('create_item').endpointMapping).toMatchObject({ method: 'POST', path: '/items', bodyMapping: { name: '$name', price: '$price', excise: '$excise' } });
    expect(tool('create_item').parameters?.properties?.excise.enum).toEqual(['untaxable', 'non_taxable', 'tax_exemption', 'five_percent', 'eight_percent', 'eight_percent_as_reduced_tax_rate', 'ten_percent']);
    expect(tool('update_item').endpointMapping.path).toBe('/items/{item_id}');
  });

  it('maps billings and quotes, creating billings in the qualified invoice format', () => {
    expect(tool('list_billings').endpointMapping).toMatchObject({ method: 'GET', path: '/billings', queryParams: { range_key: '$range_key', from: '$from', to: '$to', q: '$q', document_number: '$document_number' } });
    expect(tool('get_billing').endpointMapping.path).toBe('/billings/{billing_id}');
    expect(tool('create_billing').endpointMapping).toMatchObject({ method: 'POST', path: '/invoice_template_billings', bodyMapping: { department_id: '$department_id', billing_date: '$billing_date', items: '$items' } });
    expect(tool('create_billing').parameters?.required).toEqual(['department_id', 'billing_date']);
    expect(tool('update_billing').endpointMapping).toMatchObject({ method: 'PUT', path: '/billings/{billing_id}' });
    expect(tool('list_billing_items').endpointMapping.path).toBe('/billings/{billing_id}/items');
    expect(tool('add_billing_item').endpointMapping).toMatchObject({ method: 'POST', path: '/billings/{billing_id}/items', bodyMapping: { item_id: '$item_id', excise: '$excise', delivery_date: '$delivery_date' } });
    expect(tool('remove_billing_item').endpointMapping).toEqual({ method: 'DELETE', path: '/billings/{billing_id}/items/{item_id}' });
    expect(tool('update_billing_payment_status').endpointMapping).toEqual({ method: 'PUT', path: '/billings/{billing_id}/payment_status', bodyMapping: { payment_status: '$payment_status' } });
    expect(tool('update_billing_payment_status').parameters?.properties?.payment_status.enum).toEqual(['0', '1', '2']);
    expect(tool('post_billing').endpointMapping).toEqual({ method: 'POST', path: '/billings/{billing_id}/posting', bodyMapping: { upload_to_cloud_box: '$upload_to_cloud_box' } });
    expect(tool('list_quotes').endpointMapping).toMatchObject({ method: 'GET', path: '/quotes' });
    expect(tool('list_quotes').parameters?.properties?.range_key.enum).toEqual(['quote_date', 'expired_date', 'created_at', 'updated_at']);
    expect(tool('create_quote').endpointMapping).toMatchObject({ method: 'POST', path: '/quotes', bodyMapping: { quote_date: '$quote_date', expired_date: '$expired_date', items: '$items' } });
    expect(tool('add_quote_item').endpointMapping.path).toBe('/quotes/{quote_id}/items');
    expect(tool('update_quote_order_status').endpointMapping).toEqual({ method: 'PUT', path: '/quotes/{quote_id}/order_status', bodyMapping: { order_status: '$order_status' } });
    expect(tool('convert_quote_to_billing').endpointMapping).toEqual({ method: 'POST', path: '/quotes/{quote_id}/convert_to_billing' });
    expect(tool('list_sent_histories').endpointMapping).toEqual({ method: 'GET', path: '/sent_histories', queryParams: { page: '$page', per_page: '$per_page' } });
  });

  it('trims billing lists to the header and totals, keeping the pagination', () => {
    const out = applyResponseTransform(
      { pagination: { total_count: 1, total_pages: 1, per_page: 100, current_page: 1 }, data: [{ id: 'b1', billing_number: '0001', total_price: '11000', payment_status: '未入金', items: [{ id: 'i1' }], office_detail: 'long text', excise_price_of_ten_percent: '1000' }] },
      tool('list_billings').responseMapping as never,
    ).value;
    expect(out).toEqual({ pagination: { total_count: 1, total_pages: 1, per_page: 100, current_page: 1 }, data: [{ id: 'b1', billing_number: '0001', total_price: '11000', payment_status: '未入金' }] });
  });

  it('installs the deletes and the paid postal mailing switched off', () => {
    expect(a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort()).toEqual([`${PREFIX}delete_billing`, `${PREFIX}delete_quote`, `${PREFIX}post_billing`]);
    for (const t of a.tools) if (t.endpointMapping.method === 'DELETE') expect(`${t.name}:${t.annotations?.destructiveHint}`).toBe(`${t.name}:true`);
    expect(a.instructions).toContain(`**Switched off at install**: \`${PREFIX}delete_billing\`, \`${PREFIX}delete_quote\` and \`${PREFIX}post_billing\`; they cannot be undone`);
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
      if (t.endpointMapping.method === 'GET') expect(t.annotations?.readOnlyHint === false).toBe(false);
    }
  });

  it('probes with a read tool without required parameters and documents every tool in the instructions', () => {
    const probe = a.tools.find((t) => t.name === a.probe.tool)!;
    expect(probe.endpointMapping).toEqual({ method: 'GET', path: '/office' });
    expect(probe.parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(new Set(a.tools.map((t) => t.name)).size).toBe(a.tools.length);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const live = process.env.RUN_MONEY_FORWARD_INVOICE_LIVE === '1' && process.env.MONEY_FORWARD_ACCESS_TOKEN ? describe : describe.skip;
live('money-forward-invoice adapter: live (read-only)', () => {
  const get = async (path: string) => {
    const res = await fetch(`${a.connector.baseUrl}${path}`, { headers: { Authorization: `Bearer ${process.env.MONEY_FORWARD_ACCESS_TOKEN}`, Accept: 'application/json' } });
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
  };
  it('reads the office, partners, items, billings, quotes and sent histories', async () => {
    expect(await get('/office')).toHaveProperty('id');
    for (const p of ['/partners', '/items', '/billings', '/quotes', '/sent_histories']) {
      const body = await get(`${p}?per_page=1`);
      expect(Array.isArray(body.data)).toBe(true);
      expect(body).toHaveProperty('pagination');
    }
  }, 60_000);
});
