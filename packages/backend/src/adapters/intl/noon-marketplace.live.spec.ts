import * as adapter from './noon-marketplace.json';
import { createPrivateKey, randomUUID, sign } from 'node:crypto';

/**
 * noon Partner API (noon-docs.noonpartners.dev): one gateway at noon-api-gateway.noon.partners.
 * Login: a fresh RS256 JWT {sub: key_id, iat, jti} signed with the service account's private key,
 * POSTed with the project code to /identity/public/v1/api/login; the session comes back as cookies
 * (30 days). Every request needs a User-Agent; the content API also wants X-Project.
 * Live part (reads only: whoami, warehouses, categories, export categories):
 * NOON_KEY_ID=... NOON_PRIVATE_KEY="$(jq -r .private_key key.json)" NOON_PROJECT_CODE=... \
 *   RUN_NOON_MARKETPLACE_LIVE=1 npx jest src/adapters/intl/noon-marketplace
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters?: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, unknown>;
    encodePathParams?: boolean;
  };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  requiredEnvVars: string[];
  envVarMeta?: Record<string, { secret?: boolean; kind?: string; pattern?: string }>;
  probe: { tool: string; params?: Record<string, unknown> };
  instructions: string;
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
    headers?: Record<string, string>;
  };
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
const PREFIX = 'noon_marketplace_';
const WRITES_OFF = [
  'noon_marketplace_upsert_product',
  'noon_marketplace_upsert_product_group',
  'noon_marketplace_map_barcodes',
  'noon_marketplace_create_barcode_import',
  'noon_marketplace_upsert_prices',
  'noon_marketplace_update_stock',
  'noon_marketplace_mark_items_unavailable',
  'noon_marketplace_create_shipment',
  'noon_marketplace_cancel_shipment',
];
const WRITES_ON = ['noon_marketplace_generate_awbs', 'noon_marketplace_create_export'];

// Documented route of every tool: [method, path, body keys (null = no body mapping)].
const ROUTES: Record<string, [string, string, string[] | null]> = {
  whoami: ['GET', '/identity/v1/whoami', null],
  list_warehouses: ['POST', '/warehouse-platform/v1/warehouses/list', ['next_token', 'filters']],
  list_categories: ['POST', '/content/v1/categories/list', []],
  list_category_attributes: ['POST', '/content/v1/categories/attributes/list', ['category_code']],
  get_content: ['POST', '/content/v1/product/content/get', ['sku_parent']],
  upsert_product: ['POST', '/content/v1/product/upsert', ['skus', 'brand', 'category', 'images', 'attributes']],
  get_product_group: ['POST', '/content/v1/product/group/get', ['partner_group_ref', 'sku_parent', 'next_token', 'page_size']],
  upsert_product_group: ['POST', '/content/v1/product/group/upsert', ['partner_group_ref', 'category', 'brand', 'attribute_codes', 'sku_parents']],
  get_product_offers: ['GET', '/offer/v1/product/{partner_sku}', null],
  get_prices: ['POST', '/pricing/v1/pricing/get', ['items']],
  upsert_prices: ['POST', '/pricing/v1/pricing/upsert', ['items']],
  get_stock: ['POST', '/stock/v1/stock-list', ['items']],
  update_stock: ['POST', '/stock/v1/stock-update', ['items']],
  list_orders: ['POST', '/fbpi/v1/fbpi-orders/list', ['warehouse_code', 'created_after', 'created_before']],
  get_order: ['GET', '/fbpi/v1/fbpi-order/{fbpi_order_nr}/get', null],
  get_order_customer: ['GET', '/fbpi/v1/fbpi-order/{fbpi_order_nr}/customer-details/get', null],
  mark_items_unavailable: ['POST', '/fbpi/v1/fbpi-order/update', ['fbpi_order_nr', 'items']],
  generate_awbs: ['POST', '/fbpi/v1/shipment/noon-logistics-awbs/get', ['country_code', 'qty']],
  create_shipment: ['POST', '/fbpi/v1/shipment/create', ['warehouse_code', 'integration_shipment_nr', 'fbpi_order_nr', 'awbs', 'items']],
  get_shipment: ['POST', '/fbpi/v1/shipment/get', ['warehouse_code', 'integration_shipment_nr']],
  cancel_shipment: ['POST', '/fbpi/v1/shipment/cancel', ['warehouse_code', 'integration_shipment_nr']],
  get_purchase_order: ['GET', '/fbpo/v1/po/{po_nr}/get', null],
  list_return_references: ['POST', '/returns/v1/return-references/list', ['barcode', 'merchant_codes']],
  list_export_categories: ['GET', '/impex/v1/export/category/list', null],
  create_export: ['POST', '/impex/v1/export/create', ['export_category_code', 'params']],
  get_export_status: ['POST', '/impex/v1/export/status', ['export_code']],
  map_barcodes: ['POST', '/catplat/v1/barcode/map', ['items']],
  create_barcode_import: ['POST', '/catplat/v1/import/barcode', ['client_reference', 'items', 'file_url', 'config']],
  get_import_status: ['GET', '/catplat/v1/import/status/{reference}', null],
};

describe('noon-marketplace adapter: static spec conformance', () => {
  it('is an international e-commerce adapter for the noon gateway', () => {
    expect(a.slug).toBe('noon-marketplace');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('noon-marketplace');
    expect(a.docsUrl).toBe('https://noon-docs.noonpartners.dev/docs/getting-started/intro');
    expect(a.connector.type).toBe('REST');
    expect(a.connector.baseUrl).toBe('https://noon-api-gateway.noon.partners');
    expect(a.requiredEnvVars).toEqual(['NOON_KEY_ID', 'NOON_PRIVATE_KEY', 'NOON_PROJECT_CODE']);
    expect(a.envVarMeta?.NOON_PRIVATE_KEY.secret).toBe(true);
    expect(a.envVarMeta?.NOON_PRIVATE_KEY.kind).toBe('credential');
    expect(new RegExp(a.envVarMeta?.NOON_PRIVATE_KEY.pattern as string).test('-----BEGIN PRIVATE KEY-----\\nMIIE...')).toBe(true);
  });

  it('logs in with a signed RS256 JWT (sub = key id) and the project code, and keeps the session cookies', () => {
    const ac = a.connector.authConfig;
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(ac.loginUrl).toBe('https://noon-api-gateway.noon.partners/identity/public/v1/api/login');
    expect(ac.loginMethod).toBe('POST');
    expect(ac.loginBody).toEqual({ token: '${signedJwt}', default_project_code: '{{NOON_PROJECT_CODE}}' });
    expect(ac.signedJwt).toEqual({ privateKey: '{{NOON_PRIVATE_KEY}}', algorithm: 'RS256', claims: { sub: '{{NOON_KEY_ID}}' } });
    expect(ac).not.toHaveProperty('username');
    expect(ac).not.toHaveProperty('password');
    expect(ac).toMatchObject({ tokenSource: 'cookie', cookieMode: 'all', refreshOn401: true, headerName: 'Cookie', headerTemplate: '${token}' });
    // Sessions last 30 days (Getting Your Credentials, Terminology: Session Cookie).
    expect(ac.tokenTTLSeconds).toBe(30 * 24 * 60 * 60);
  });

  it('sends a User-Agent on the login and on every call, and X-Project with the project code', () => {
    const lh = a.connector.authConfig.loginHeaders as Record<string, string>;
    expect(lh['User-Agent']).toMatch(/\S/);
    expect(lh['Content-Type']).toBe('application/json');
    expect(a.connector.headers?.['User-Agent']).toMatch(/\S/);
    expect(a.connector.headers?.['X-Project']).toBe('{{NOON_PROJECT_CODE}}');
    expect(a.connector.headers?.Accept).toBe('application/json');
  });

  it('maps every tool to its documented route and body fields', () => {
    expect(a.tools.map((t) => t.name).sort()).toEqual(Object.keys(ROUTES).map((n) => PREFIX + n).sort());
    for (const [n, [method, path, body]] of Object.entries(ROUTES)) {
      const m = tool(PREFIX + n).endpointMapping;
      expect(`${n}:${m.method} ${m.path}`).toBe(`${n}:${method} ${path}`);
      if (body === null) expect(`${n}:${JSON.stringify(m.bodyMapping)}`).toBe(`${n}:undefined`);
      else expect(`${n}:${Object.keys(m.bodyMapping as object).sort().join(',')}`).toBe(`${n}:${[...body].sort().join(',')}`);
    }
    expect(tool('noon_marketplace_list_warehouses').endpointMapping.bodyMapping).toEqual({
      next_token: '$next_token',
      filters: { fulfillment_system_code: '$fulfillment_system_code' },
    });
    expect(tool('noon_marketplace_list_orders').endpointMapping.queryParams).toEqual({ next_token: '$next_token' });
    for (const n of ['get_prices', 'upsert_prices', 'get_stock', 'update_stock']) {
      expect(tool(PREFIX + n).endpointMapping.bodyMapping).toEqual({ items: '$items' });
      expect((tool(PREFIX + n).parameters?.properties?.items as { type: string }).type).toBe('array');
    }
    const priceItem = (tool('noon_marketplace_upsert_prices').parameters?.properties?.items as { items: { properties: Record<string, unknown>; required: string[] } }).items;
    expect(Object.keys(priceItem.properties).sort()).toEqual(['country_code', 'is_active', 'msrp', 'partner_sku', 'price']);
    expect(priceItem.required).toEqual(['partner_sku', 'country_code']);
    const stockItem = (tool('noon_marketplace_update_stock').parameters?.properties?.items as { items: { properties: Record<string, unknown> } }).items;
    expect(Object.keys(stockItem.properties).sort()).toEqual(['partner_sku', 'processing_time', 'qty', 'warehouse_code']);
    expect(tool('noon_marketplace_get_product_offers').endpointMapping.encodePathParams).toBe(true);
    expect(tool('noon_marketplace_get_import_status').endpointMapping.encodePathParams).toBe(true);
    // BarcodeSkuMap takes {items: [{barcode, partner_sku, force_map}]}.
    expect(tool('noon_marketplace_map_barcodes').endpointMapping.bodyMapping).toEqual({ items: '$items' });
    const barcodeItem = (tool('noon_marketplace_map_barcodes').parameters?.properties?.items as { items: { properties: Record<string, unknown>; required: string[] } }).items;
    expect(Object.keys(barcodeItem.properties).sort()).toEqual(['barcode', 'force_map', 'partner_sku']);
    expect(barcodeItem.required.sort()).toEqual(['barcode', 'partner_sku']);
    // CreateBarcodeImport nests the inline list as items.data and the overwrite flag as config.force_sync.
    const imp = tool('noon_marketplace_create_barcode_import');
    expect(imp.endpointMapping.bodyMapping).toEqual({
      client_reference: '$client_reference',
      items: '$items',
      file_url: '$file_url',
      config: { force_sync: '$force_sync' },
    });
    expect(imp.parameters?.required).toEqual(['client_reference']);
    const inline = (imp.parameters?.properties?.items as { properties: { data: { maxItems: number; items: { required: string[] } } } }).properties.data;
    expect(inline.maxItems).toBe(10000);
    expect(inline.items.required.sort()).toEqual(['barcode', 'partner_sku']);
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

  it('installs price, stock, product and order writes switched off; reads are GET or marked read-only', () => {
    const off = a.tools.filter((t) => t.enabled === false).map((t) => t.name).sort();
    expect(off).toEqual([...WRITES_OFF].sort());
    for (const n of [...WRITES_OFF, ...WRITES_ON]) expect(`${n}:${tool(n).annotations?.readOnlyHint}`).toBe(`${n}:false`);
    for (const n of WRITES_ON) expect(`${n}:${tool(n).enabled}`).toBe(`${n}:undefined`);
    for (const t of a.tools) {
      if (t.annotations?.readOnlyHint === false) continue;
      expect(`${t.name}:${t.enabled}`).toBe(`${t.name}:undefined`);
      expect(`${t.name}:${t.annotations?.readOnlyHint}`).toBe(`${t.name}:true`);
    }
    for (const n of ['noon_marketplace_cancel_shipment', 'noon_marketplace_upsert_product_group', 'noon_marketplace_mark_items_unavailable']) {
      expect(tool(n).annotations?.destructiveHint).toBe(true);
    }
  });

  it('probes with whoami and documents every tool in the instructions', () => {
    expect(a.probe.tool).toBe('noon_marketplace_whoami');
    expect(tool(a.probe.tool).endpointMapping.method).toBe('GET');
    for (const t of a.tools) expect(`${t.name}:${a.instructions.includes(t.name)}`).toBe(`${t.name}:true`);
    expect(JSON.stringify(a)).not.toMatch(/\u2014/);
  });
});

const env = process.env;
const live =
  env.RUN_NOON_MARKETPLACE_LIVE === '1' && env.NOON_KEY_ID && env.NOON_PRIVATE_KEY && env.NOON_PROJECT_CODE ? describe : describe.skip;
live('noon-marketplace adapter: live (read-only)', () => {
  const base = 'https://noon-api-gateway.noon.partners';
  const UA = 'AnythingMCP/1.0';
  const b64url = (v: string | Buffer) => Buffer.from(v).toString('base64url');
  const signedJwt = () => {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: env.NOON_KEY_ID, iat: Math.floor(Date.now() / 1000), jti: randomUUID() }));
    const key = createPrivateKey((env.NOON_PRIVATE_KEY as string).replace(/\\n/g, '\n'));
    return `${header}.${payload}.${b64url(sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), key))}`;
  };

  it('logs in with a signed JWT and reads whoami, warehouses, categories and export categories', async () => {
    const login = await fetch(a.connector.authConfig.loginUrl as string, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ token: signedJwt(), default_project_code: env.NOON_PROJECT_CODE }),
    });
    expect(login.status).toBe(200);
    const cookies = login.headers.getSetCookie().map((c) => c.split(';')[0]);
    expect(cookies.length).toBeGreaterThan(0);
    const headers = { Cookie: cookies.join('; '), Accept: 'application/json', 'User-Agent': UA, 'X-Project': env.NOON_PROJECT_CODE as string };
    const post = (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    const me = (await (await fetch(`${base}/identity/v1/whoami`, { headers })).json()) as { user_code: string; username: string };
    expect(typeof me.user_code).toBe('string');
    const wh = (await (await post('/warehouse-platform/v1/warehouses/list', { filters: {} })).json()) as { warehouses: unknown[] };
    expect(Array.isArray(wh.warehouses)).toBe(true);
    const cats = (await (await post('/content/v1/categories/list', {})).json()) as { categories: string[] };
    expect(cats.categories.length).toBeGreaterThan(0);
    const exp = (await (await fetch(`${base}/impex/v1/export/category/list`, { headers })).json()) as { export_categories: unknown[] };
    expect(Array.isArray(exp.export_categories)).toBe(true);
  }, 60_000);
});
