import * as adapter from './salesforce-commerce-cloud.json';
/**
 * Salesforce B2C Commerce Cloud (SCAPI Admin APIs) adapter.
 *
 * Static checks always run: the Account Manager client-credentials token with
 * the tenant scope and the six API scopes, the short-code host, the
 * organization id built from the tenant id, every route against Salesforce's
 * Admin API specs (Orders 1.6.4, Products 1.2.0, Catalogs 1.0.47, Inventory
 * Lists 1.1.0, Customers 1.1.4), the default site and the switched-off order
 * and payment status tools. This adapter is separate from the CRM adapter
 * intl/salesforce.json.
 *
 * Live checks run only with RUN_SALESFORCE_COMMERCE_CLOUD_LIVE=1 and
 * SFCC_SHORT_CODE, SFCC_TENANT_ID, SFCC_SITE_ID, SFCC_CLIENT_ID,
 * SFCC_CLIENT_SECRET set: they fetch a token and read one order. Reads only.
 *
 *   RUN_SALESFORCE_COMMERCE_CLOUD_LIVE=1 SFCC_SHORT_CODE=... SFCC_TENANT_ID=... SFCC_SITE_ID=... \
 *     SFCC_CLIENT_ID=... SFCC_CLIENT_SECRET=... npx jest src/adapters/intl/salesforce-commerce-cloud.live.spec.ts
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
  salesforce_commerce_cloud_list_orders: ["GET", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders"],
  salesforce_commerce_cloud_get_order: ["GET", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders/{order_no}"],
  salesforce_commerce_cloud_update_order_shipping_status: ["PUT", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders/{order_no}/shipping-status"],
  salesforce_commerce_cloud_update_order_export_status: ["PUT", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders/{order_no}/export-status"],
  salesforce_commerce_cloud_update_order_confirmation_status: ["PUT", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders/{order_no}/confirmation-status"],
  salesforce_commerce_cloud_update_order_external_status: ["PUT", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders/{order_no}/external-status"],
  salesforce_commerce_cloud_update_order_status: ["PUT", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders/{order_no}/status"],
  salesforce_commerce_cloud_update_order_payment_status: ["PUT", "/checkout/orders/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/orders/{order_no}/payment-status"],
  salesforce_commerce_cloud_search_products: ["POST", "/product/products/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/product-search"],
  salesforce_commerce_cloud_query_products: ["POST", "/product/products/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/product-search"],
  salesforce_commerce_cloud_get_product: ["GET", "/product/products/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/products/{product_id}"],
  salesforce_commerce_cloud_list_product_variations: ["GET", "/product/products/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/products/{master_product_id}/variations"],
  salesforce_commerce_cloud_update_product: ["PATCH", "/product/products/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/products/{product_id}"],
  salesforce_commerce_cloud_list_catalogs: ["GET", "/product/catalogs/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/catalogs"],
  salesforce_commerce_cloud_list_categories: ["GET", "/product/catalogs/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/catalogs/{catalog_id}/categories"],
  salesforce_commerce_cloud_get_category: ["GET", "/product/catalogs/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/catalogs/{catalog_id}/categories/{category_id}"],
  salesforce_commerce_cloud_get_inventory_list: ["GET", "/product/inventory-lists/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/inventory-lists/{inventory_list_id}"],
  salesforce_commerce_cloud_get_inventory_record: ["GET", "/product/inventory-lists/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/inventory-lists/{inventory_list_id}/product-inventory-records/{product_id}"],
  salesforce_commerce_cloud_update_inventory_record: ["PATCH", "/product/inventory-lists/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/inventory-lists/{inventory_list_id}/product-inventory-records/{product_id}"],
  salesforce_commerce_cloud_search_customers: ["POST", "/customer/customers/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/customer-lists/{customer_list_id}/customer-search"],
  salesforce_commerce_cloud_get_customer: ["GET", "/customer/customers/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/customer-lists/{customer_list_id}/customers/{customer_no}"],
  salesforce_commerce_cloud_list_customer_addresses: ["GET", "/customer/customers/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/customer-lists/{customer_list_id}/customers/{customer_no}/addresses"],
  salesforce_commerce_cloud_list_customer_groups: ["GET", "/customer/customers/v1/organizations/f_ecom_{{SFCC_TENANT_ID}}/customer-groups"],
};
const SWITCHED_OFF = [
  "salesforce_commerce_cloud_update_order_payment_status",
  "salesforce_commerce_cloud_update_order_status",
];
const REQUIRED: Record<string, string[]> = {
  salesforce_commerce_cloud_list_orders: [],
  salesforce_commerce_cloud_get_order: ["order_no"],
  salesforce_commerce_cloud_update_order_shipping_status: ["order_no", "status"],
  salesforce_commerce_cloud_update_order_export_status: ["order_no", "status"],
  salesforce_commerce_cloud_update_order_confirmation_status: ["order_no", "status"],
  salesforce_commerce_cloud_update_order_external_status: ["order_no", "status"],
  salesforce_commerce_cloud_update_order_status: ["order_no", "status"],
  salesforce_commerce_cloud_update_order_payment_status: ["order_no", "status"],
  salesforce_commerce_cloud_search_products: ["search_phrase"],
  salesforce_commerce_cloud_query_products: ["query"],
  salesforce_commerce_cloud_get_product: ["product_id"],
  salesforce_commerce_cloud_list_product_variations: ["master_product_id"],
  salesforce_commerce_cloud_update_product: ["product_id"],
  salesforce_commerce_cloud_list_catalogs: [],
  salesforce_commerce_cloud_list_categories: ["catalog_id"],
  salesforce_commerce_cloud_get_category: ["catalog_id", "category_id"],
  salesforce_commerce_cloud_get_inventory_list: ["inventory_list_id"],
  salesforce_commerce_cloud_get_inventory_record: ["inventory_list_id", "product_id"],
  salesforce_commerce_cloud_update_inventory_record: ["allocation", "inventory_list_id", "product_id"],
  salesforce_commerce_cloud_search_customers: ["customer_list_id", "search_phrase"],
  salesforce_commerce_cloud_get_customer: ["customer_list_id", "customer_no"],
  salesforce_commerce_cloud_list_customer_addresses: ["customer_list_id", "customer_no"],
  salesforce_commerce_cloud_list_customer_groups: [],
};
const PROBE = {"tool": "salesforce_commerce_cloud_list_orders", "params": {"limit": 1}};
const PROBE_METHOD = "GET";

describe('salesforce-commerce-cloud adapter: static contract', () => {
  it('asks Account Manager for a client-credentials token with the tenant scope', () => {
    expect(a.slug).toBe('salesforce-commerce-cloud');
    expect(a.icon).toBe('salesforce-commerce-cloud');
    expect(a.connector.baseUrl).toBe('https://{{SFCC_SHORT_CODE}}.api.commercecloud.salesforce.com');
    expect(a.connector.authType).toBe('OAUTH2');
    expect(a.connector.authConfig).toEqual({
      grant: 'client_credentials',
      clientId: '{{SFCC_CLIENT_ID}}',
      clientSecret: '{{SFCC_CLIENT_SECRET}}',
      tokenUrl: 'https://account.demandware.com/dwsso/oauth2/access_token',
      tokenAuthMethod: 'client_secret_basic',
      scope: 'SALESFORCE_COMMERCE_API:{{SFCC_TENANT_ID}} sfcc.orders.rw sfcc.products.rw sfcc.catalogs sfcc.inventory-lists.rw sfcc.customerlists sfcc.customergroups',
    });
    expect(a.requiredEnvVars).toEqual(['SFCC_SHORT_CODE', 'SFCC_TENANT_ID', 'SFCC_CLIENT_ID', 'SFCC_CLIENT_SECRET']);
    expect(a.optionalEnvVars).toEqual(['SFCC_SITE_ID']);
    const tenant = new RegExp(a.envVarMeta.SFCC_TENANT_ID.pattern!);
    for (const ok of ['zzrf_001', 'abcd_prd', 'bjxx_stg']) expect(tenant.test(ok)).toBe(true);
    for (const bad of ['f_ecom_zzrf_001', 'zzrf001']) expect(tenant.test(bad)).toBe(false);
    expect(new RegExp(a.envVarMeta.SFCC_SHORT_CODE.pattern!).test('kv7kzm78')).toBe(true);
  });

  it('builds the organization id from the tenant id and fills the site from the connector', () => {
    for (const t of a.tools) expect(t.endpointMapping.path).toContain('/organizations/f_ecom_{{SFCC_TENANT_ID}}/');
    for (const t of a.tools) {
      const query = t.endpointMapping.queryParams ?? {};
      if ('siteId' in query) {
        expect(query.siteId).toBe('$site_id');
        expect(t.endpointMapping.envDefaults).toEqual({ site_id: 'SFCC_SITE_ID' });
        expect(t.parameters.required ?? []).not.toContain('site_id');
      }
    }
  });

  it('sends the documented search and status bodies', () => {
    expect(tool('salesforce_commerce_cloud_search_products').endpointMapping.bodyMapping).toEqual({
      query: { textQuery: { fields: ['id', 'name'], searchPhrase: '$search_phrase' } },
      limit: '$limit',
      offset: '$offset',
    });
    expect(tool('salesforce_commerce_cloud_update_order_shipping_status').endpointMapping.bodyMapping).toEqual({ status: '$status' });
    expect(tool('salesforce_commerce_cloud_update_inventory_record').endpointMapping.bodyMapping).toEqual({
      allocation: { amount: '$allocation' },
      perpetualFlag: '$perpetual_flag',
      inStockDate: '$in_stock_date',
    });
    for (const name of ['salesforce_commerce_cloud_search_products', 'salesforce_commerce_cloud_query_products', 'salesforce_commerce_cloud_search_customers']) {
      expect(tool(name).annotations).toEqual({ readOnlyHint: true });
    }
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

const live = process.env.RUN_SALESFORCE_COMMERCE_CLOUD_LIVE === '1' ? describe : describe.skip;
live('salesforce-commerce-cloud adapter: live reads', () => {
  it('fetches a token and reads one order', async () => {
    const e = process.env;
    const basic = Buffer.from(`${e.SFCC_CLIENT_ID}:${e.SFCC_CLIENT_SECRET}`).toString('base64');
    const scope = `${a.connector.authConfig.scope}`.replace('{{SFCC_TENANT_ID}}', `${e.SFCC_TENANT_ID}`);
    const tokenRes = await fetch('https://account.demandware.com/dwsso/oauth2/access_token', {
      method: 'POST',
      headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
    });
    expect(tokenRes.status).toBe(200);
    const token = ((await tokenRes.json()) as { access_token: string }).access_token;
    const url = `https://${e.SFCC_SHORT_CODE}.api.commercecloud.salesforce.com/checkout/orders/v1/organizations/f_ecom_${e.SFCC_TENANT_ID}/orders?siteId=${e.SFCC_SITE_ID}&limit=1`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });
});
