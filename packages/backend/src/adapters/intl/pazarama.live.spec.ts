import * as adapter from './pazarama.json';
/**
 * Pazarama seller integration API adapter.
 *
 * Static checks always run: the client-credentials login at
 * isortagimgiris.pazarama.com (Basic auth, form body, token read from the
 * wrapped data.accessToken), the errorWhen rule for success false, every route
 * against Pazarama's integration documentation
 * (https://isortagim.pazarama.com/auth/integration/token-alma and the pages
 * next to it), the write bodies, and which tools install switched off (return
 * and cancellation answers, not-supplied, bulk sale status). No tool moves money.
 *
 * Live checks run only with RUN_PAZARAMA_LIVE=1: they read the city list (no
 * token) and, with PAZARAMA_API_KEY and PAZARAMA_API_SECRET, fetch a token and
 * read one page of brands. Reads only.
 *
 *   RUN_PAZARAMA_LIVE=1 PAZARAMA_API_KEY=... PAZARAMA_API_SECRET=... \
 *     npx jest src/adapters/intl/pazarama.live.spec.ts
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
  pazarama_list_orders: ["POST", "/order/getOrdersForApi"],
  pazarama_list_orders_split: ["POST", "/order/getOrdersForApiV2"],
  pazarama_update_item_status: ["PUT", "/order/updateOrderStatus"],
  pazarama_ship_item: ["PUT", "/order/updateOrderStatus"],
  pazarama_bulk_update_item_status: ["PUT", "/order/api/bulk-status-update"],
  pazarama_update_order_status: ["PUT", "/order/updateOrderStatusList"],
  pazarama_send_invoice_link: ["POST", "/order/invoice-link"],
  pazarama_list_packages: ["GET", "/order/api/shipment-packages/orderId={order_id}"],
  pazarama_create_packages: ["POST", "/order/api/packages-split"],
  pazarama_update_packages: ["PUT", "/order/update-packages"],
  pazarama_list_approved_products: ["GET", "/product/products/approved"],
  pazarama_list_unapproved_products: ["GET", "/product/products/unapproved"],
  pazarama_get_product: ["POST", "/product/getProductDetail"],
  pazarama_create_products: ["POST", "/product/create"],
  pazarama_get_product_batch_result: ["GET", "/product/getProductBatchResult"],
  pazarama_search_catalog: ["POST", "/product/getProductTitleCodeSearch"],
  pazarama_add_catalog_product: ["POST", "/product/addProductsWithBarcodes"],
  pazarama_set_product_sale_status: ["POST", "/product/external-status"],
  pazarama_bulk_set_product_sale_status: ["POST", "/product/bulkUpdateProductStatusFromApi"],
  pazarama_update_prices: ["POST", "/product/updatePrice-v2"],
  pazarama_update_stock: ["POST", "/product/updateStock-v2"],
  pazarama_get_listing_result: ["GET", "/listing-state/batch-id/{batch_id}/lake-projections"],
  pazarama_list_brands: ["GET", "/brand/getBrands"],
  pazarama_list_categories: ["GET", "/category/getCategoryTree"],
  pazarama_get_category_attributes: ["GET", "/category/getCategoryWithAttributes"],
  pazarama_get_seller_delivery: ["GET", "/sellerRegister/getSellerDelivery"],
  pazarama_list_cities: ["GET", "/parameter/cities"],
  pazarama_list_returns: ["POST", "/order/getRefund"],
  pazarama_update_return: ["POST", "/order/updateRefund"],
  pazarama_list_cancellation_requests: ["POST", "/order/api/cancel/items"],
  pazarama_answer_cancellation_request: ["PUT", "/order/api/cancel"],
  pazarama_report_not_supplied: ["PUT", "/order/updateOrderStatus"],
  pazarama_list_question_statuses: ["GET", "/QuestionAnswer/getQuestionStatus"],
  pazarama_list_question_topics: ["POST", "/QuestionAnswer/questionTopics"],
  pazarama_search_questions: ["POST", "/QuestionAnswer/getApprovalAnswersByMerchantSearch"],
  pazarama_list_unanswered_questions: ["GET", "/QuestionAnswer/getApprovalAnswersByMerchant"],
  pazarama_get_question: ["GET", "/QuestionAnswer/getApprovalAnswerById"],
  pazarama_answer_question: ["PUT", "/QuestionAnswer/sellerAnswer"],
  pazarama_get_payment_agreement: ["POST", "/order/paymentAgreement"],
};
const SWITCHED_OFF = [
  "pazarama_answer_cancellation_request",
  "pazarama_bulk_set_product_sale_status",
  "pazarama_report_not_supplied",
  "pazarama_update_return"
];
const REQUIRED: Record<string, string[]> = {
  pazarama_list_orders: ["end_date", "start_date"],
  pazarama_list_orders_split: ["end_date", "start_date"],
  pazarama_update_item_status: ["order_item_id", "order_number", "status"],
  pazarama_ship_item: ["cargo_company_id", "order_item_id", "order_number", "tracking_number"],
  pazarama_bulk_update_item_status: ["order_item_ids", "order_number", "status"],
  pazarama_update_order_status: ["order_number", "status"],
  pazarama_send_invoice_link: ["invoice_link", "order_id"],
  pazarama_list_packages: ["order_id"],
  pazarama_create_packages: ["order_id", "packages", "seller_id"],
  pazarama_update_packages: ["packages"],
  pazarama_list_approved_products: [],
  pazarama_list_unapproved_products: [],
  pazarama_get_product: ["code"],
  pazarama_create_products: ["products"],
  pazarama_get_product_batch_result: ["batch_request_id"],
  pazarama_search_catalog: ["seller_id"],
  pazarama_add_catalog_product: ["code", "list_price", "product_id", "sale_price", "stock_count"],
  pazarama_set_product_sale_status: ["code", "product_status"],
  pazarama_bulk_set_product_sale_status: ["product_items"],
  pazarama_update_prices: ["items"],
  pazarama_update_stock: ["items"],
  pazarama_get_listing_result: ["batch_id"],
  pazarama_list_brands: [],
  pazarama_list_categories: [],
  pazarama_get_category_attributes: ["category_id"],
  pazarama_get_seller_delivery: [],
  pazarama_list_cities: [],
  pazarama_list_returns: [],
  pazarama_update_return: ["refund_id", "status"],
  pazarama_list_cancellation_requests: [],
  pazarama_answer_cancellation_request: ["refund_id", "status"],
  pazarama_report_not_supplied: ["order_item_id", "order_number"],
  pazarama_list_question_statuses: [],
  pazarama_list_question_topics: [],
  pazarama_search_questions: [],
  pazarama_list_unanswered_questions: [],
  pazarama_get_question: ["question_id"],
  pazarama_answer_question: ["question_id", "text"],
  pazarama_get_payment_agreement: [],
};
const PROBE = {"tool": "pazarama_list_brands", "params": {"size": 1}};
const PROBE_METHOD = "GET";

describe('pazarama adapter: static contract', () => {
  it('logs in with client credentials and reads the wrapped token', () => {
    expect(a.slug).toBe('pazarama');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.connector.baseUrl).toBe('https://isortagimapi.pazarama.com');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: 'https://isortagimgiris.pazarama.com/connect/token',
      loginMethod: 'POST',
      loginBasicAuth: true,
      username: '{{PAZARAMA_API_KEY}}',
      password: '{{PAZARAMA_API_SECRET}}',
      loginBody: 'grant_type=client_credentials&scope=merchantgatewayapi.fullaccess',
      loginHeaders: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      tokenJsonPath: ['data.accessToken', 'access_token'],
      tokenTTLSeconds: 3600,
      proactiveRefreshSeconds: 300,
      refreshOn401: true,
      headerName: 'Authorization',
      headerTemplate: 'Bearer ${token}',
    });
    expect(a.connector.config?.errorWhen).toEqual([{ path: 'success', equals: false, messagePath: 'message', status: 400 }]);
    expect(a.requiredEnvVars).toEqual(['PAZARAMA_API_KEY', 'PAZARAMA_API_SECRET']);
    expect(a.envVarMeta.PAZARAMA_API_SECRET.secret).toBe(true);
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

  it('marks the POST reads read-only and fixes the status of the shipping and not-supplied calls', () => {
    for (const name of ['pazarama_list_orders', 'pazarama_list_orders_split', 'pazarama_get_product', 'pazarama_search_catalog', 'pazarama_list_returns', 'pazarama_list_cancellation_requests', 'pazarama_list_question_topics', 'pazarama_search_questions', 'pazarama_get_payment_agreement']) {
      expect(`${name}:${JSON.stringify(tool(name).annotations)}`).toBe(`${name}:{"readOnlyHint":true}`);
    }
    expect(tool('pazarama_ship_item').endpointMapping.bodyMapping).toMatchObject({ item: { status: 5 } });
    expect(tool('pazarama_report_not_supplied').endpointMapping.bodyMapping).toMatchObject({ item: { status: 13 } });
    expect(JSON.stringify(tool('pazarama_update_item_status').parameters)).not.toMatch(/\b13\b/);
    expect(tool('pazarama_update_prices').endpointMapping.bodyMapping).toEqual({ items: '$items' });
    expect(tool('pazarama_list_packages').endpointMapping.path).toBe('/order/api/shipment-packages/orderId={order_id}');
  });
});

const live = process.env.RUN_PAZARAMA_LIVE === '1' ? describe : describe.skip;
live('pazarama adapter: live reads', () => {
  it('reads the city list without a token', async () => {
    const res = await fetch('https://isortagimapi.pazarama.com/parameter/cities', { headers: { Accept: 'application/json' } });
    expect(res.status).toBe(200);
  });

  it('fetches a token and reads one page of brands', async () => {
    const key = process.env.PAZARAMA_API_KEY;
    const secret = process.env.PAZARAMA_API_SECRET;
    if (!key || !secret) throw new Error('Set PAZARAMA_API_KEY and PAZARAMA_API_SECRET for the live check');
    const login = await fetch('https://isortagimgiris.pazarama.com/connect/token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: 'grant_type=client_credentials&scope=merchantgatewayapi.fullaccess',
    });
    expect(login.status).toBe(200);
    const body = (await login.json()) as { data?: { accessToken?: string }; access_token?: string };
    const token = body.data?.accessToken ?? body.access_token;
    expect(token).toBeTruthy();
    const brands = await fetch('https://isortagimapi.pazarama.com/brand/getBrands?Page=1&Size=1', { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
    expect(brands.status).toBe(200);
  });
});
