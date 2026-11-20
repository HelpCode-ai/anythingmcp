import axios from 'axios';
import * as adapter from './cj-dropshipping.json';

/**
 * CJ Dropshipping API 2.0 adapter.
 *
 * Static checks always run: the key-for-token login (the API key posted to
 * getAccessToken, the token sent in CJ-Access-Token), the error codes CJ
 * answers inside HTTP 200, every tool's method and path against the CJ
 * documentation, that an order is always created unpaid (payType 3), and
 * that no tool pays from the wallet balance.
 * https://developers.cjdropshipping.com/en/api/introduction.html
 *
 * Live checks run only with RUN_CJ_DROPSHIPPING_LIVE=1. Without credentials
 * they confirm that a wrong key is refused inside an HTTP 200 answer; with
 * CJ_API_KEY they log in and read the account settings (no points). Reads
 * only; CJ allows one login call per second.
 *
 *   RUN_CJ_DROPSHIPPING_LIVE=1 CJ_API_KEY=... \
 *     npx jest src/adapters/intl/cj-dropshipping.live.spec.ts
 */

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: {
    properties?: Record<
      string,
      { description?: string; enum?: unknown[]; pattern?: string; minimum?: number; maximum?: number; default?: unknown }
    >;
    required?: string[];
  };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, unknown>;
    bodyMapping?: unknown;
    headers?: Record<string, string>;
  };
  annotations?: { readOnlyHint?: boolean };
};
const a = adapter as unknown as {
  slug: string;
  name: string;
  region: string;
  category: string;
  icon: string;
  docsUrl: string;
  instructions: string;
  aliases?: string[];
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  envVarMeta: Record<
    string,
    { pattern?: string; kind?: string; secret?: boolean; options?: Array<{ value: string; label: string }> }
  >;
  verifyHints: Record<string, string>;
  probe: { tool: string; params?: Record<string, unknown> };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig: Record<string, unknown>;
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
/** Every argument an endpoint mapping reads: {name} in the path, $name and ${name} elsewhere. */
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

/** Tool name: [method, path, required arguments], as the vendor documents each operation. */
const CONTRACT: Record<string, [string, string, string[]]> = {
  cj_dropshipping_get_settings: ['GET', '/setting/get', []],
  cj_dropshipping_list_categories: ['GET', '/product/getCategory', []],
  cj_dropshipping_search_products: ['GET', '/product/listV2', []],
  cj_dropshipping_get_product: ['GET', '/product/query', []],
  cj_dropshipping_list_my_products: ['GET', '/product/myProduct/query', []],
  cj_dropshipping_list_variants: ['GET', '/product/variant/query', []],
  cj_dropshipping_get_variant: ['GET', '/product/variant/queryByVid', ['vid']],
  cj_dropshipping_get_stock_by_variant: ['GET', '/product/stock/queryByVid', ['vid']],
  cj_dropshipping_get_stock_by_sku: ['GET', '/product/stock/queryBySku', ['sku']],
  cj_dropshipping_get_stock_by_product: ['GET', '/product/stock/getInventoryByPid', ['pid']],
  cj_dropshipping_list_product_reviews: ['GET', '/product/productComments', ['pid']],
  cj_dropshipping_list_global_warehouses: ['GET', '/product/globalWarehouseList', []],
  cj_dropshipping_list_warehouses: ['GET', '/warehouse/list', []],
  cj_dropshipping_get_warehouse: ['GET', '/warehouse/detail', ['id']],
  cj_dropshipping_list_orders: ['GET', '/shopping/order/list', []],
  cj_dropshipping_get_order: ['GET', '/shopping/order/getOrderDetail', ['order_id']],
  cj_dropshipping_get_order_logs: ['POST', '/shopping/order/queryOrderLog', ['order_code']],
  cj_dropshipping_create_order: ['POST', '/shopping/order/createOrderV2', ['order_number', 'shipping_customer_name', 'shipping_address', 'shipping_city', 'shipping_province', 'shipping_country_code', 'shipping_country', 'logistic_name', 'from_country_code', 'products']],
  cj_dropshipping_confirm_order: ['PATCH', '/shopping/order/confirmOrder', ['order_id']],
  cj_dropshipping_delete_order: ['DELETE', '/shopping/order/deleteOrder', ['order_id']],
  cj_dropshipping_cancel_order: ['POST', '/shopping/order/cancel', []],
  cj_dropshipping_get_balance: ['GET', '/shopping/pay/getBalance', []],
  cj_dropshipping_calculate_freight: ['POST', '/logistic/freightCalculate', ['start_country_code', 'end_country_code', 'products']],
  cj_dropshipping_get_tracking: ['GET', '/logistic/trackInfo', ['track_numbers']],
  cj_dropshipping_list_dispute_products: ['GET', '/disputes/disputeProducts', ['order_id']],
  cj_dropshipping_list_disputes: ['GET', '/disputes/getDisputeList', []],
  cj_dropshipping_get_dispute: ['GET', '/disputes/getDisputeDetail', ['dispute_id']],
};
/** Installed switched off: confirming commits an order towards payment; deleting and cancelling remove orders. */
const SWITCHED_OFF: string[] = ['cj_dropshipping_confirm_order', 'cj_dropshipping_delete_order', 'cj_dropshipping_cancel_order'];
/** Tools on a write method that only read (searches and calculations). */
const POST_READS: string[] = ['cj_dropshipping_get_order_logs', 'cj_dropshipping_calculate_freight'];

describe('cj-dropshipping adapter: static contract', () => {
  it('is filed under intl/e-commerce with its own icon and documentation link', () => {
    expect(a.slug).toBe('cj-dropshipping');
    expect(a.name).toBe('CJ Dropshipping');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('cj-dropshipping');
    expect(a.docsUrl).toBe('https://developers.cjdropshipping.com/en/api/introduction.html');
    expect(a.connector.type).toBe('REST');
  });

  it('exchanges the API key for a token and sends it in CJ-Access-Token', () => {
    expect(a.connector.baseUrl).toBe('https://developers.cjdropshipping.com/api2.0/v1');
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig).toEqual({
      loginUrl: 'https://developers.cjdropshipping.com/api2.0/v1/authentication/getAccessToken',
      loginMethod: 'POST',
      loginHeaders: { 'Content-Type': 'application/json', Accept: 'application/json' },
      loginBody: { apiKey: '${password}' },
      username: '{{CJ_API_KEY}}',
      password: '{{CJ_API_KEY}}',
      tokenJsonPath: 'data.accessToken',
      expiryJsonPath: 'data.accessTokenExpiryDate',
      expiryFormat: 'iso8601',
      tokenTTLSeconds: 1296000,
      proactiveRefreshSeconds: 86400,
      refreshOn401: true,
      refreshOnBody401: true,
      headerName: 'CJ-Access-Token',
      headerTemplate: '${token}',
    });
    expect(a.requiredEnvVars).toEqual(['CJ_API_KEY']);
    expect(a.envVarMeta.CJ_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    expect(new RegExp(a.envVarMeta.CJ_API_KEY.pattern!).test('CJ1234567@api@0123456789abcdef0123456789abcdef')).toBe(true);
    expect(new RegExp(a.envVarMeta.CJ_API_KEY.pattern!).test('has a space')).toBe(false);
  });

  it('reads the CJ error codes that arrive inside an HTTP 200 answer', () => {
    const rules = a.connector.config?.errorWhen as Array<{ path: string; in?: number[]; matches?: string; status: number }>;
    expect(rules.every((rule) => rule.path === 'code')).toBe(true);
    const statusOf = (code: number) =>
      rules.find((rule) => (rule.in ? rule.in.includes(code) : new RegExp(rule.matches ?? '$^', 'i').test(String(code))))?.status;
    // 1600001: invalid or expired token, which makes the engine log in again.
    expect(statusOf(1600001)).toBe(401);
    expect(statusOf(1600014)).toBe(403);
    expect(statusOf(1600200)).toBe(429);
    expect(statusOf(1600101)).toBe(404);
    expect(statusOf(1600300)).toBe(400);
    // 200 and 0 are success and match no rule.
    expect(statusOf(200)).toBeUndefined();
    expect(statusOf(0)).toBeUndefined();
  });

  it('declares exactly the documented operations, each with its method, path and required arguments', () => {
    expect(a.tools.map((entry) => entry.name).sort()).toEqual(Object.keys(CONTRACT).sort());
    for (const [name, [method, path, required]] of Object.entries(CONTRACT)) {
      const entry = tool(name);
      expect([name, entry.endpointMapping.method, entry.endpointMapping.path]).toEqual([name, method, path]);
      expect([name, ...(entry.parameters.required ?? [])]).toEqual([name, ...required]);
    }
  });

  it('prefixes every tool and declares every argument it reads', () => {
    const names = new Set(a.tools.map((entry) => entry.name));
    expect(names.size).toBe(a.tools.length);
    const envNames = new Set([...a.requiredEnvVars, ...(a.optionalEnvVars ?? [])]);
    for (const entry of a.tools) {
      expect(entry.name).toMatch(/^cj_dropshipping_[a-z0-9_]+$/);
      expect(entry.description.length).toBeGreaterThanOrEqual(60);
      const declared = new Set(Object.keys(entry.parameters.properties ?? {}));
      const read = used(entry);
      for (const arg of read) expect([entry.name, arg, declared.has(arg) || envNames.has(arg)]).toEqual([entry.name, arg, true]);
      for (const arg of declared) expect([entry.name, arg, read.has(arg)]).toEqual([entry.name, arg, true]);
      for (const req of entry.parameters.required ?? []) expect(declared.has(req)).toBe(true);
      for (const [arg, schema] of Object.entries(entry.parameters.properties ?? {})) {
        expect([entry.name, arg, Boolean(schema.description)]).toEqual([entry.name, arg, true]);
      }
    }
  });

  it('marks reads read-only and installs the risky writes switched off', () => {
    for (const entry of a.tools) {
      const reads = entry.endpointMapping.method === 'GET' || POST_READS.includes(entry.name);
      expect([entry.name, entry.annotations?.readOnlyHint === true]).toEqual([entry.name, reads]);
    }
    expect(
      a.tools
        .filter((entry) => entry.enabled === false)
        .map((entry) => entry.name)
        .sort(),
    ).toEqual([...SWITCHED_OFF].sort());
    for (const entry of a.tools) {
      if (entry.endpointMapping.method === 'DELETE') expect(SWITCHED_OFF).toContain(entry.name);
    }
  });

  it('names every tool in the instructions and keeps the texts safe to render', () => {
    const outsideCode = (text: string) => text.replace(/`[^`]*`/g, '');
    for (const entry of a.tools) {
      expect(a.instructions).toContain(entry.name);
      expect(outsideCode(entry.description)).not.toMatch(/[{}<]/);
    }
    expect(outsideCode(a.instructions)).not.toMatch(/[{}<]/);
    expect(a.instructions).not.toMatch(/\u2014/);
    expect(a.instructions.startsWith('## CJ Dropshipping')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'cj_dropshipping_get_settings', params: {} });
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of a.requiredEnvVars) expect(a.envVarMeta[name]).toBeTruthy();
  });

  it('always creates an order unpaid and has no tool that pays from the balance', () => {
    const body = tool('cj_dropshipping_create_order').endpointMapping.bodyMapping as Record<string, unknown>;
    // payType 3: create only, without payment, add-to-cart or confirmation.
    expect(body.payType).toBe(3);
    expect(tool('cj_dropshipping_create_order').parameters.properties).not.toHaveProperty('pay_type');
    const payPaths = a.tools.map((entry) => entry.endpointMapping.path).filter((path) => path.startsWith('/shopping/pay'));
    expect(payPaths).toEqual(['/shopping/pay/getBalance']);
    for (const entry of a.tools) expect(entry.endpointMapping.path).not.toMatch(/payBalance|sandbox|wallet/i);
  });

  it('reads disputes without opening, replying to or cancelling them', () => {
    const disputes = a.tools.filter((entry) => entry.endpointMapping.path.startsWith('/disputes'));
    expect(disputes.map((entry) => entry.endpointMapping.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('sends several tracking numbers as a repeated trackNumber parameter', () => {
    expect(tool('cj_dropshipping_get_tracking').endpointMapping.queryParams).toEqual({ trackNumber: '$track_numbers' });
  });
});

// Opt-in: RUN_CJ_DROPSHIPPING_LIVE=1. Reads only; nothing is created or changed.
const live = process.env.RUN_CJ_DROPSHIPPING_LIVE === '1';
(live ? describe : describe.skip)('CJ Dropshipping: live', () => {
  const base = 'https://developers.cjdropshipping.com/api2.0/v1';

  it('refuses a wrong API key inside an HTTP 200 answer', async () => {
    const response = await axios.post(
      `${base}/authentication/getAccessToken`,
      { apiKey: 'CJ0000000@api@00000000000000000000000000000000' },
      { validateStatus: () => true },
    );
    expect(response.status).toBe(200);
    expect(response.data.result).toBe(false);
    expect(response.data.data).toBeNull();
  });

  it('logs in and reads the account settings', async () => {
    const apiKey = process.env.CJ_API_KEY;
    if (!apiKey) throw new Error('Set CJ_API_KEY for the live check');
    const login = await axios.post(`${base}/authentication/getAccessToken`, { apiKey }, { validateStatus: () => true });
    expect(login.data.code).toBe(200);
    const token = login.data.data.accessToken as string;
    expect(typeof login.data.data.accessTokenExpiryDate).toBe('string');
    const settings = await axios.get(`${base}/setting/get`, { headers: { 'CJ-Access-Token': token }, validateStatus: () => true });
    expect(settings.data.code).toBe(200);
  });
});
