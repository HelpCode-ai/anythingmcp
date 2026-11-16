import * as adapter from './hepsiburada.json';
/**
 * Hepsiburada merchant API adapter (orders, listings, catalog, claims,
 * customer questions, shipping profiles).
 *
 * Static checks always run: HTTP Basic with the merchant id and service key,
 * the integrator username as User-Agent, every route against Hepsiburada's
 * published OpenAPI documents (https://developers.hepsiburada.com, production
 * hosts = test hosts without -sit), the merchantId header of the questions
 * service, the form-data answer, the top-level array bodies, and which tools
 * install switched off (line cancellation, listing deactivate and delete,
 * claim accept and reject, question report). No tool buys labels or moves money.
 *
 * Live checks run only with RUN_HEPSIBURADA_LIVE=1. Without credentials they
 * confirm the order host refuses an anonymous call; with HEPSIBURADA_MERCHANT_ID,
 * HEPSIBURADA_SERVICE_KEY and HEPSIBURADA_INTEGRATOR_USERNAME they read one page
 * of listings. Reads only.
 *
 *   RUN_HEPSIBURADA_LIVE=1 HEPSIBURADA_MERCHANT_ID=... HEPSIBURADA_SERVICE_KEY=... \
 *     HEPSIBURADA_INTEGRATOR_USERNAME=... npx jest src/adapters/intl/hepsiburada.live.spec.ts
 */
type Mapping = {
  method: string;
  path: string;
  queryParams?: Record<string, unknown>;
  bodyMapping?: unknown;
  headers?: Record<string, string>;
};
type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, { description?: string; pattern?: string }>; required?: string[] };
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
  selfHostOnly?: boolean;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<string, { pattern?: string; secret?: boolean; kind?: string; label?: string; help?: string; options?: { value: string; label: string }[] }>;
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
  hepsiburada_list_orders: ["GET", "/orders/merchantid/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_get_order: ["GET", "/orders/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/ordernumber/{order_number}"],
  hepsiburada_list_payment_awaiting_orders: ["GET", "/orders/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/paymentawaiting"],
  hepsiburada_list_cancelled_orders: ["GET", "/orders/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/cancelled"],
  hepsiburada_list_packageable_lines: ["GET", "/lineitems/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packageablewith/lineitemid/{line_item_id}"],
  hepsiburada_create_package: ["POST", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_list_packages: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_list_shipped_packages: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/shipped"],
  hepsiburada_list_delivered_packages: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/delivered"],
  hepsiburada_list_undelivered_packages: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/undelivered"],
  hepsiburada_list_missing_invoice_packages: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/missing-invoice"],
  hepsiburada_list_unpacked_packages: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/status/unpacked"],
  hepsiburada_get_package: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}"],
  hepsiburada_unpack_package: ["POST", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/unpack"],
  hepsiburada_split_package: ["POST", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/split"],
  hepsiburada_list_line_cargo_companies: ["GET", "/delivery/changeablecargocompanies/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/orderlineid/{order_line_id}"],
  hepsiburada_change_line_cargo_company: ["PUT", "/lineitems/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/orderlineid/{order_line_id}/cargocompany"],
  hepsiburada_list_package_cargo_companies: ["GET", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/changablecargocompanies"],
  hepsiburada_change_package_cargo_company: ["PUT", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/changecargocompany"],
  hepsiburada_mark_package_in_transit: ["POST", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/intransit"],
  hepsiburada_mark_package_delivered: ["POST", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/deliver"],
  hepsiburada_mark_package_undelivered: ["POST", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/undeliver"],
  hepsiburada_send_invoice_link: ["PUT", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/invoice"],
  hepsiburada_update_parcel_info: ["PUT", "/packages/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/packagenumber/{package_number}/parcel-info"],
  hepsiburada_cancel_order_line: ["POST", "/lineitems/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/id/{line_id}/cancelbymerchant"],
  hepsiburada_list_listings: ["GET", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_upload_prices: ["POST", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/price-uploads"],
  hepsiburada_get_price_upload: ["GET", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/price-uploads/id/{upload_id}"],
  hepsiburada_upload_stock: ["POST", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/stock-uploads"],
  hepsiburada_get_stock_upload: ["GET", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/stock-uploads/id/{upload_id}"],
  hepsiburada_update_listing: ["POST", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/sku/{hb_sku}/merchantsku/{merchant_sku}"],
  hepsiburada_activate_listing: ["POST", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/sku/{hb_sku}/activate"],
  hepsiburada_deactivate_listing: ["POST", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/sku/{hb_sku}/deactivate"],
  hepsiburada_delete_listing: ["DELETE", "https://listing-external.hepsiburada.com/listings/merchantid/{{HEPSIBURADA_MERCHANT_ID}}/sku/{hb_sku}/merchantsku/{merchant_sku}"],
  hepsiburada_get_buybox_ranking: ["GET", "https://listing-external.hepsiburada.com/buybox-orders/merchantid/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_get_commissions: ["GET", "https://listing-external.hepsiburada.com/commissions/merchantid/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_list_categories: ["GET", "https://mpop.hepsiburada.com/product/api/categories/get-all-categories"],
  hepsiburada_get_category_attributes: ["GET", "https://mpop.hepsiburada.com/product/api/categories/{category_id}/attributes"],
  hepsiburada_list_attribute_values: ["GET", "https://mpop.hepsiburada.com/product/api/categories/{category_id}/attribute/{attribute_id}/values"],
  hepsiburada_get_product_import_status: ["GET", "https://mpop.hepsiburada.com/product/api/products/status/{tracking_id}"],
  hepsiburada_list_tracking_ids: ["GET", "https://mpop.hepsiburada.com/product/api/products/trackingId-history"],
  hepsiburada_list_products_by_status: ["GET", "https://mpop.hepsiburada.com/product/api/products/products-by-merchant-and-status"],
  hepsiburada_list_merchant_products: ["GET", "https://mpop.hepsiburada.com/product/api/products/all-products-of-merchant/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_check_product_status: ["POST", "https://mpop.hepsiburada.com/product/api/products/check-product-status"],
  hepsiburada_fast_list_product: ["POST", "https://mpop.hepsiburada.com/product/api/products/fastlisting"],
  hepsiburada_list_claims: ["GET", "/claims/merchantId/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_list_claims_by_status: ["GET", "/claims/merchantId/{{HEPSIBURADA_MERCHANT_ID}}/status/{status}"],
  hepsiburada_accept_claim: ["POST", "/claims/number/{claim_number}/accept"],
  hepsiburada_reject_claim: ["POST", "/claims/number/{claim_number}/reject"],
  hepsiburada_preapprove_claim: ["POST", "/claims/number/{claim_number}/preapprovalconfirm"],
  hepsiburada_list_questions: ["GET", "https://api-asktoseller-merchant.hepsiburada.com/api/v1.0/issues"],
  hepsiburada_get_question: ["GET", "https://api-asktoseller-merchant.hepsiburada.com/api/v1.0/issues/{issue_number}"],
  hepsiburada_count_questions: ["GET", "https://api-asktoseller-merchant.hepsiburada.com/api/v1.0/issues/count"],
  hepsiburada_answer_question: ["POST", "https://api-asktoseller-merchant.hepsiburada.com/api/v1.0/issues/{issue_number}/answer"],
  hepsiburada_report_question: ["POST", "https://api-asktoseller-merchant.hepsiburada.com/api/v1.0/issues/{issue_number}/reject"],
  hepsiburada_list_cargo_firms: ["GET", "https://shipping-external.hepsiburada.com/cargoFirms/{{HEPSIBURADA_MERCHANT_ID}}"],
  hepsiburada_list_shipping_profiles: ["GET", "https://shipping-external.hepsiburada.com/profiles/{{HEPSIBURADA_MERCHANT_ID}}"],
};
const SWITCHED_OFF = [
  "hepsiburada_accept_claim",
  "hepsiburada_cancel_order_line",
  "hepsiburada_deactivate_listing",
  "hepsiburada_delete_listing",
  "hepsiburada_reject_claim",
  "hepsiburada_report_question"
];
const REQUIRED: Record<string, string[]> = {
  hepsiburada_list_orders: [],
  hepsiburada_get_order: ["order_number"],
  hepsiburada_list_payment_awaiting_orders: [],
  hepsiburada_list_cancelled_orders: [],
  hepsiburada_list_packageable_lines: ["line_item_id"],
  hepsiburada_create_package: ["line_items"],
  hepsiburada_list_packages: [],
  hepsiburada_list_shipped_packages: [],
  hepsiburada_list_delivered_packages: [],
  hepsiburada_list_undelivered_packages: [],
  hepsiburada_list_missing_invoice_packages: [],
  hepsiburada_list_unpacked_packages: [],
  hepsiburada_get_package: ["package_number"],
  hepsiburada_unpack_package: ["package_number"],
  hepsiburada_split_package: ["package_number", "packages"],
  hepsiburada_list_line_cargo_companies: ["order_line_id"],
  hepsiburada_change_line_cargo_company: ["cargo_company_short_name", "order_line_id"],
  hepsiburada_list_package_cargo_companies: ["package_number"],
  hepsiburada_change_package_cargo_company: ["cargo_company_short_name", "package_number"],
  hepsiburada_mark_package_in_transit: ["package_number", "shipped_date"],
  hepsiburada_mark_package_delivered: ["package_number"],
  hepsiburada_mark_package_undelivered: ["package_number", "reason"],
  hepsiburada_send_invoice_link: ["package_number"],
  hepsiburada_update_parcel_info: ["package_number"],
  hepsiburada_cancel_order_line: ["line_id"],
  hepsiburada_list_listings: [],
  hepsiburada_upload_prices: ["items"],
  hepsiburada_get_price_upload: ["upload_id"],
  hepsiburada_upload_stock: ["items"],
  hepsiburada_get_stock_upload: ["upload_id"],
  hepsiburada_update_listing: ["hb_sku", "merchant_sku"],
  hepsiburada_activate_listing: ["hb_sku"],
  hepsiburada_deactivate_listing: ["hb_sku"],
  hepsiburada_delete_listing: ["hb_sku", "merchant_sku"],
  hepsiburada_get_buybox_ranking: ["skus"],
  hepsiburada_get_commissions: ["skus"],
  hepsiburada_list_categories: [],
  hepsiburada_get_category_attributes: ["category_id"],
  hepsiburada_list_attribute_values: ["attribute_id", "category_id"],
  hepsiburada_get_product_import_status: ["tracking_id"],
  hepsiburada_list_tracking_ids: [],
  hepsiburada_list_products_by_status: ["product_status"],
  hepsiburada_list_merchant_products: [],
  hepsiburada_check_product_status: ["merchant_skus"],
  hepsiburada_fast_list_product: ["merchant_sku", "product_name"],
  hepsiburada_list_claims: [],
  hepsiburada_list_claims_by_status: ["status"],
  hepsiburada_accept_claim: ["claim_number"],
  hepsiburada_reject_claim: ["claim_number", "reason", "statement"],
  hepsiburada_preapprove_claim: ["claim_number"],
  hepsiburada_list_questions: [],
  hepsiburada_get_question: ["issue_number"],
  hepsiburada_count_questions: [],
  hepsiburada_answer_question: ["answer", "issue_number"],
  hepsiburada_report_question: ["issue_number", "reason"],
  hepsiburada_list_cargo_firms: [],
  hepsiburada_list_shipping_profiles: [],
};
const PROBE = {"tool": "hepsiburada_list_listings", "params": {"limit": 1}};
const PROBE_METHOD = "GET";

describe('hepsiburada adapter: static contract', () => {
  it('signs with HTTP Basic (merchant id and service key) and the integrator username as User-Agent', () => {
    expect(a.slug).toBe('hepsiburada');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('https://oms-external.hepsiburada.com');
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig).toEqual({ username: '{{HEPSIBURADA_MERCHANT_ID}}', password: '{{HEPSIBURADA_SERVICE_KEY}}' });
    expect(a.connector.headers).toEqual({ Accept: 'application/json', 'User-Agent': '{{HEPSIBURADA_INTEGRATOR_USERNAME}}' });
    expect(a.requiredEnvVars).toEqual(['HEPSIBURADA_MERCHANT_ID', 'HEPSIBURADA_SERVICE_KEY', 'HEPSIBURADA_INTEGRATOR_USERNAME']);
    expect(a.envVarMeta.HEPSIBURADA_SERVICE_KEY.secret).toBe(true);
    expect(new RegExp(a.envVarMeta.HEPSIBURADA_MERCHANT_ID.pattern!).test('1a514334-5b66-45f9-9f47-7223ed8ca1db')).toBe(true);
    expect(new RegExp(a.envVarMeta.HEPSIBURADA_MERCHANT_ID.pattern!).test('123456')).toBe(false);
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
      const used = refs([m.queryParams ?? {}, m.bodyMapping ?? {}, m.headers ?? {}]);
      for (const p of pathParams(m.path)) used.add(p);
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

  it('keeps parameter patterns compilable', () => {
    for (const t of a.tools) {
      for (const d of Object.values(t.parameters.properties ?? {})) if (d.pattern) expect(() => new RegExp(d.pattern as string)).not.toThrow();
    }
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

  it('calls only the production hosts, never a -sit test host', () => {
    const hosts = new Set<string>();
    for (const t of a.tools) {
      const p = t.endpointMapping.path;
      const url = /^https:/.test(p) ? p : `${a.connector.baseUrl}${p}`;
      expect(url).not.toContain('-sit');
      hosts.add(new URL(url.replace(/\{\{\w+\}\}/g, 'x')).host);
    }
    expect([...hosts].sort()).toEqual([
      'api-asktoseller-merchant.hepsiburada.com',
      'listing-external.hepsiburada.com',
      'mpop.hepsiburada.com',
      'oms-external.hepsiburada.com',
      'shipping-external.hepsiburada.com',
    ]);
  });

  it('puts the merchant id into paths, the questions header and the catalog bodies', () => {
    expect(tool('hepsiburada_list_orders').endpointMapping.path).toBe('/orders/merchantid/{{HEPSIBURADA_MERCHANT_ID}}');
    for (const t of a.tools.filter((x) => x.endpointMapping.path.includes('asktoseller'))) {
      expect(t.endpointMapping.headers).toEqual({ merchantId: '{{HEPSIBURADA_MERCHANT_ID}}' });
    }
    expect(tool('hepsiburada_check_product_status').endpointMapping.bodyMapping).toEqual([{ merchant: '{{HEPSIBURADA_MERCHANT_ID}}', merchantSkuList: '$merchant_skus' }]);
    expect((tool('hepsiburada_answer_question').endpointMapping as unknown as { bodyEncoding: string }).bodyEncoding).toBe('form-data');
    expect(tool('hepsiburada_answer_question').endpointMapping.bodyMapping).toEqual({ Answer: '$answer' });
    expect(tool('hepsiburada_upload_prices').endpointMapping.bodyMapping).toEqual({ __raw: '$items' });
    expect(tool('hepsiburada_upload_stock').endpointMapping.bodyMapping).toEqual({ __raw: '$items' });
  });

  it('fills the mandatory offset and limit, and sends no cancellation through the split', () => {
    const props = tool('hepsiburada_list_orders').parameters.properties as unknown as Record<string, { default?: unknown }>;
    expect(props.offset.default).toBe(0);
    expect(props.limit.default).toBe(100);
    expect(JSON.stringify(tool('hepsiburada_split_package').endpointMapping.bodyMapping)).not.toContain('cancelledItems');
    expect(a.tools.map((t) => t.endpointMapping.path).join(' ')).not.toMatch(/products\/import|ticket-api|delete-process|labels|mpfinance/);
  });
});

const live = process.env.RUN_HEPSIBURADA_LIVE === '1' ? describe : describe.skip;
live('hepsiburada adapter: live', () => {
  it('refuses an anonymous call on the order host', async () => {
    const res = await fetch('https://oms-external.hepsiburada.com/orders/merchantid/00000000-0000-0000-0000-000000000000?offset=0&limit=1', {
      headers: { 'User-Agent': 'anythingmcp_test', Accept: 'application/json' },
    });
    expect([401, 403]).toContain(res.status);
  });

  it('reads one page of listings', async () => {
    const id = process.env.HEPSIBURADA_MERCHANT_ID;
    const key = process.env.HEPSIBURADA_SERVICE_KEY;
    const ua = process.env.HEPSIBURADA_INTEGRATOR_USERNAME;
    if (!id || !key || !ua) throw new Error('Set HEPSIBURADA_MERCHANT_ID, HEPSIBURADA_SERVICE_KEY and HEPSIBURADA_INTEGRATOR_USERNAME');
    const res = await fetch(`https://listing-external.hepsiburada.com/listings/merchantid/${id}?offset=0&limit=1`, {
      headers: { Authorization: `Basic ${Buffer.from(`${id}:${key}`).toString('base64')}`, 'User-Agent': ua, Accept: 'application/json' },
    });
    expect(res.status).toBe(200);
  });
});
