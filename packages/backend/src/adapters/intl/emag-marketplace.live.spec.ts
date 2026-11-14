import * as adapter from './emag-marketplace.json';
import { applyResponseTransform } from '../../connectors/response-transform.util';

/**
 * eMAG Marketplace API (API 3, documentation v4.5.2, OpenAPI "eMAG & FD Marketplace API"):
 * base https://marketplace-api.emag.{ro,bg,hu}/api-3 (Fashion Days hosts on the same API),
 * HTTP Basic auth with an API user, IP whitelisting by eMAG. Resources are POST
 * <resource>/read|count|save; reads take filters as top-level body keys, saves a `data` list.
 * Answers are { isError, messages, results }.
 * Live part (reads only: VAT rates, handling times, categories, offers, orders):
 *   EMAG_API_HOST=https://marketplace-api.emag.ro EMAG_USERNAME=... EMAG_PASSWORD=... \
 *   RUN_EMAG_MARKETPLACE_LIVE=1 npx jest src/adapters/intl/emag-marketplace
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, { enum?: unknown[]; type?: string }>; required?: string[] };
  endpointMapping: { method: string; path: string; queryParams?: Record<string, unknown>; bodyMapping?: unknown; headers?: Record<string, unknown> };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  responseMapping?: unknown;
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { pattern?: string; secret?: boolean; kind?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: { baseUrl: string; authType: string; authConfig?: Record<string, unknown>; config?: { errorWhen?: Array<Record<string, unknown>> } };
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
const PREFIX = 'emag_marketplace_';
const READS_OVER_POST = /\/(read|count|categories)$/;

describe('emag-marketplace adapter: static spec conformance', () => {
  it('authenticates with HTTP Basic on the platform host chosen in EMAG_API_HOST', () => {
    expect(a.slug).toBe('emag-marketplace');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.requiredEnvVars).toEqual(['EMAG_API_HOST', 'EMAG_USERNAME', 'EMAG_PASSWORD']);
    expect(a.connector.baseUrl).toBe('{{EMAG_API_HOST}}/api-3');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{EMAG_USERNAME}}', password: '{{EMAG_PASSWORD}}' });
    expect(a.envVarMeta?.EMAG_PASSWORD.secret).toBe(true);
    const host = new RegExp(a.envVarMeta?.EMAG_API_HOST.pattern ?? '');
    for (const ok of ['https://marketplace-api.emag.ro', 'https://marketplace-api.emag.bg', 'https://marketplace-api.emag.hu', 'https://marketplace-ro-api.fashiondays.com']) expect(host.test(ok)).toBe(true);
    for (const bad of ['https://marketplace-api.emag.ro/api-3', 'https://marketplace.emag.ro', 'http://marketplace-api.emag.ro']) expect(host.test(bad)).toBe(false);
  });

  it('reports isError answers as failures, the IP and credential refusals as auth errors first', () => {
    const rules = a.connector.config?.errorWhen ?? [];
    expect(rules[0]).toMatchObject({ path: 'isError', equals: true, messagePath: 'messages', status: 403 });
    expect(String(rules[0].messageMatches)).toMatch(/not allowed to use this API/);
    expect(rules[rules.length - 1]).toEqual({ path: 'isError', equals: true, messagePath: 'messages', status: 400 });
  });

  it('maps the documented read, count and save resources', () => {
    expect(tool('emag_marketplace_list_vat_rates').endpointMapping).toEqual({ method: 'POST', path: '/vat/read', bodyMapping: {} });
    expect(tool('emag_marketplace_list_handling_times').endpointMapping.path).toBe('/handling_time/read');
    expect(tool('emag_marketplace_list_categories').endpointMapping).toEqual({
      method: 'POST',
      path: '/category/read',
      bodyMapping: { id: '$id', currentPage: '$currentPage', itemsPerPage: '$itemsPerPage', valuesCurrentPage: '$valuesCurrentPage', valuesPerPage: '$valuesPerPage' },
      queryParams: { language: '$language' },
    });
    expect(tool('emag_marketplace_count_categories').endpointMapping.path).toBe('/category/count');
    expect(tool('emag_marketplace_list_product_offers').endpointMapping).toMatchObject({ path: '/product_offer/read', bodyMapping: { status: '$status', part_number_key: '$part_number_key', validation_status: '$validation_status', currentPage: '$currentPage', itemsPerPage: '$itemsPerPage' } });
    expect(tool('emag_marketplace_count_product_offers').endpointMapping.path).toBe('/product_offer/count');
    expect(tool('emag_marketplace_find_products_by_ean').endpointMapping).toEqual({ method: 'GET', path: '/documentation/find_by_eans', queryParams: { 'eans[]': '$eans' } });
    expect(tool('emag_marketplace_list_orders').endpointMapping).toMatchObject({ path: '/order/read', bodyMapping: { status: '$status', createdAfter: '$createdAfter', createdBefore: '$createdBefore', modifiedAfter: '$modifiedAfter', payment_mode_id: '$payment_mode_id', type: '$type' } });
    expect(tool('emag_marketplace_count_orders').endpointMapping.path).toBe('/order/count');
    expect(tool('emag_marketplace_list_order_attachments').endpointMapping.path).toBe('/order/attachments/read');
    expect(tool('emag_marketplace_get_order_volumetry').endpointMapping.path).toBe('/order/volumetry/read');
    expect(tool('emag_marketplace_get_awb').endpointMapping).toEqual({ method: 'POST', path: '/awb/read', bodyMapping: { emag_id: '$emag_id', reservation_id: '$reservation_id' } });
    expect(tool('emag_marketplace_get_awb_pdf').endpointMapping).toEqual({ method: 'GET', path: '/awb/read_pdf', queryParams: { emag_id: '$emag_id', awb_format: '$awb_format' } });
    expect(tool('emag_marketplace_get_awb_zpl').endpointMapping.path).toBe('/awb/read_zpl');
    expect(tool('emag_marketplace_list_returns').endpointMapping).toMatchObject({ path: '/rma/read', bodyMapping: { request_status: '$request_status', date_start: '$date_start' } });
    expect(tool('emag_marketplace_count_returns').endpointMapping.path).toBe('/rma/count');
    expect(tool('emag_marketplace_list_localities').endpointMapping.path).toBe('/locality/read');
    expect(tool('emag_marketplace_list_courier_accounts').endpointMapping.path).toBe('/courier_accounts/read');
    expect(tool('emag_marketplace_list_addresses').endpointMapping.path).toBe('/addresses/read');
    expect(tool('emag_marketplace_list_awb_packages').endpointMapping.path).toBe('/awb/package/read');
    expect(tool('emag_marketplace_list_campaigns').endpointMapping).toMatchObject({ path: '/campaigns/read', bodyMapping: { campaignType: '$campaignType', status: '$status' } });
    expect(tool('emag_marketplace_list_campaign_categories').endpointMapping.path).toBe('/campaign_categories/read');
    expect(tool('emag_marketplace_list_campaign_eligible_offers').endpointMapping).toEqual({ method: 'GET', path: '/campaigns/{campaign_id}/eligible-offers', queryParams: { pageSize: '$pageSize', lastId: '$lastId' } });
    expect(tool('emag_marketplace_get_offer_campaign_badges').endpointMapping.path).toBe('/offers/{ext_id}/campaign_product_badge_timeline');
    expect(tool('emag_marketplace_check_smart_deals_price').endpointMapping).toEqual({ method: 'GET', path: '/smart-deals-price-check', queryParams: { productId: '$productId' } });
    expect(tool('emag_marketplace_list_invoice_categories').endpointMapping.path).toBe('/invoice/categories');
    expect(tool('emag_marketplace_list_invoices').endpointMapping.path).toBe('/invoice/read');
    expect(tool('emag_marketplace_list_customer_invoices').endpointMapping.path).toBe('/customer-invoice/read');
  });

  it('wraps every save payload in data and keeps the special routes', () => {
    for (const [name, path, arg] of [
      ['emag_marketplace_update_offers', '/offer/save', 'offers'],
      ['emag_marketplace_save_product_offers', '/product_offer/save', 'products'],
      ['emag_marketplace_save_measurements', '/measurements/save', 'measurements'],
      ['emag_marketplace_save_order', '/order/save', 'orders'],
      ['emag_marketplace_save_order_attachments', '/order/attachments/save', 'attachments'],
      ['emag_marketplace_create_awb', '/awb/save', 'awbs'],
      ['emag_marketplace_save_return', '/rma/save', 'returns'],
      ['emag_marketplace_propose_campaign_offers', '/campaign_proposals/save', 'proposals'],
    ]) {
      expect(tool(name).endpointMapping).toEqual({ method: 'POST', path, bodyMapping: { data: `$${arg}` } });
      expect(tool(name).parameters?.properties?.[arg].type).toBe('array');
    }
    expect(tool('emag_marketplace_update_offer_stock').endpointMapping).toEqual({ method: 'PATCH', path: '/offer_stock/{resource_id}', bodyMapping: { data: { stock: '$stock' } } });
    expect(tool('emag_marketplace_acknowledge_order').endpointMapping).toEqual({ method: 'POST', path: '/order/acknowledge/{order_id}' });
    expect(tool('emag_marketplace_unlock_courier').endpointMapping).toEqual({ method: 'POST', path: '/order/{order_id}/unlock-courier' });
  });

  it('marks every POST read and count read-only and every save as a write', () => {
    for (const t of a.tools) {
      const m = t.endpointMapping;
      const read = m.method === 'GET' || (m.method === 'POST' && READS_OVER_POST.test(m.path));
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:${read}`);
    }
  });

  it('drops the long description from offer lists', () => {
    const out = applyResponseTransform(
      { isError: false, messages: [], results: [{ id: 1, sale_price: 10, description: '<p>long</p>', safety_information: 'x', stock: [{ warehouse_id: 1, value: 3 }] }] },
      tool('emag_marketplace_list_product_offers').responseMapping as never,
    ).value;
    expect(out).toEqual({ isError: false, messages: [], results: [{ id: 1, sale_price: 10, stock: [{ warehouse_id: 1, value: 3 }] }] });
  });

  it('every tool is prefixed, every declared parameter reaches the request and path parameters are required', () => {
    for (const t of a.tools) {
      expect(t.name.startsWith(PREFIX)).toBe(true);
      const u = used(t);
      const props = Object.keys(t.parameters?.properties ?? {});
      for (const p of props) expect(`${t.name}:${p}:${u.has(p)}`).toBe(`${t.name}:${p}:true`);
      for (const p of u) expect(`${t.name}:${p}:${props.includes(p)}`).toBe(`${t.name}:${p}:true`);
      for (const [, p] of t.endpointMapping.path.replace(/\{\{\w+\}\}/g, '').matchAll(/\{(\w+)\}/g)) expect(t.parameters?.required).toContain(p);
    }
  });

  it('probes with a read tool and documents every tool in the instructions', () => {
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    expect(tool(a.probe.tool).parameters?.required ?? []).toEqual([]);
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/—/);
  });
});

const env = process.env;
const live = env.RUN_EMAG_MARKETPLACE_LIVE === '1' && env.EMAG_API_HOST && env.EMAG_USERNAME && env.EMAG_PASSWORD ? describe : describe.skip;
live('emag-marketplace adapter: live (read-only)', () => {
  const auth = `Basic ${Buffer.from(`${env.EMAG_USERNAME}:${env.EMAG_PASSWORD}`).toString('base64')}`;
  const read = async (path: string, body: Record<string, unknown> = {}) => {
    const res = await fetch(`${env.EMAG_API_HOST}/api-3${path}`, {
      method: 'POST',
      headers: { Authorization: auth, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { isError: boolean; messages: unknown[]; results: unknown };
    expect(json.isError).toBe(false);
    return json.results;
  };
  it('reads VAT rates, handling times, categories, offers, orders and returns', async () => {
    expect(Array.isArray(await read('/vat/read'))).toBe(true);
    expect(Array.isArray(await read('/handling_time/read'))).toBe(true);
    expect(Array.isArray(await read('/category/read', { currentPage: 1, itemsPerPage: 5 }))).toBe(true);
    expect(Array.isArray(await read('/product_offer/read', { currentPage: 1, itemsPerPage: 5 }))).toBe(true);
    expect(Array.isArray(await read('/order/read', { currentPage: 1, itemsPerPage: 5 }))).toBe(true);
    expect(Array.isArray(await read('/rma/read', { currentPage: 1, itemsPerPage: 5 }))).toBe(true);
  }, 60_000);
});
