import axios from 'axios';
import * as adapter from './michaels-marketplace.json';

/**
 * Michaels Marketplace seller API adapter (https://www.michaels.com/api/mkp/v1).
 *
 * Static checks always run: the Api-Key header, the two environments
 * (production and the /uat sandbox), every tool's method and path, the
 * one-element array bodies of the inventory and price updates, the order
 * confirmation and shipment bodies, and that cancelling installs switched
 * off. No tool handles returns or refunds.
 * https://www.michaels.com/developer-api/guide?path=api/authentication
 *
 * Live checks run only with RUN_MICHAELS_MARKETPLACE_LIVE=1 and need
 * MICHAELS_API_KEY (MICHAELS_API_URL defaults to production). They call the
 * authentication test and read one page of orders. Reads only.
 *
 *   RUN_MICHAELS_MARKETPLACE_LIVE=1 MICHAELS_API_KEY=... \
 *     npx jest src/adapters/intl/michaels-marketplace.live.spec.ts
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
  michaels_marketplace_test_authentication: ['GET', '/listing/authentication/test-auth', []],
  michaels_marketplace_list_all_listings: ['GET', '/listing/all-listings', []],
  michaels_marketplace_query_listings: ['GET', '/listing/query', []],
  michaels_marketplace_get_listing: ['GET', '/listing/{sku_number}', ['sku_number']],
  michaels_marketplace_get_inventory: ['GET', '/listing/inventory/{primary_sku_number}', ['primary_sku_number']],
  michaels_marketplace_get_price: ['GET', '/listing/price/{primary_sku_number}', ['primary_sku_number']],
  michaels_marketplace_update_inventory: ['POST', '/listing/inventory/update-inventory-by-seller-sku-number', ['seller_sku_number', 'available_quantity']],
  michaels_marketplace_update_price: ['POST', '/listing/price/publish-by-seller-sku-number', ['seller_sku_number', 'price']],
  michaels_marketplace_query_orders: ['GET', '/order/query', []],
  michaels_marketplace_get_order: ['GET', '/order/{order_number}', ['order_number']],
  michaels_marketplace_confirm_orders: ['POST', '/order/confirm', ['order_numbers']],
  michaels_marketplace_ship_order: ['POST', '/order/shipped', ['order_number', 'shipments']],
  michaels_marketplace_cancel_order: ['POST', '/order/cancel-order', ['order_number', 'cancel_order_lines']],
};
/** Installed switched off: a cancellation cannot be undone and counts against the seller. */
const SWITCHED_OFF: string[] = ['michaels_marketplace_cancel_order'];
/** Tools on a write method that only read (searches and calculations). */
const POST_READS: string[] = [];

describe('michaels-marketplace adapter: static contract', () => {
  it('is filed under intl/e-commerce with its own icon and documentation link', () => {
    expect(a.slug).toBe('michaels-marketplace');
    expect(a.name).toBe('Michaels Marketplace');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('michaels-marketplace');
    expect(a.docsUrl).toBe('https://www.michaels.com/developer-api/guide?path=api/authentication');
    expect(a.connector.type).toBe('REST');
  });

  it('sends the key in the Api-Key header and offers production and sandbox', () => {
    expect(a.connector.baseUrl).toBe('{{MICHAELS_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'Api-Key', apiKey: '{{MICHAELS_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['MICHAELS_API_URL', 'MICHAELS_API_KEY']);
    expect(a.envVarMeta.MICHAELS_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const url = a.envVarMeta.MICHAELS_API_URL;
    expect(url.secret).toBeUndefined();
    expect(url.options?.map((option) => option.value)).toEqual([
      'https://www.michaels.com/api/mkp/v1',
      'https://www.michaels.com/api/mkp/v1/uat',
    ]);
    for (const option of url.options ?? []) expect(new RegExp(url.pattern!).test(option.value)).toBe(true);
    expect(new RegExp(url.pattern!).test('https://example.org/api/mkp/v1')).toBe(false);
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
      expect(entry.name).toMatch(/^michaels_marketplace_[a-z0-9_]+$/);
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
    expect(a.instructions.startsWith('## Michaels Marketplace')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'michaels_marketplace_test_authentication', params: {} });
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const key of ['401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of a.requiredEnvVars) expect(a.envVarMeta[name]).toBeTruthy();
  });

  it('updates stock and price for one seller SKU as a one-element list', () => {
    expect(tool('michaels_marketplace_update_inventory').endpointMapping.bodyMapping).toEqual([
      { sellerSkuNumber: '$seller_sku_number', availableQuantity: '$available_quantity' },
    ]);
    expect(tool('michaels_marketplace_update_price').endpointMapping.bodyMapping).toEqual([
      { sellerSkuNumber: '$seller_sku_number', price: '$price' },
    ]);
  });

  it('confirms and ships orders with the documented bodies', () => {
    expect(tool('michaels_marketplace_confirm_orders').endpointMapping.bodyMapping).toEqual({ orderNumbers: '$order_numbers' });
    expect(tool('michaels_marketplace_ship_order').endpointMapping.bodyMapping).toEqual({
      orderNumber: '$order_number',
      shipmentsList: '$shipments',
    });
    expect(tool('michaels_marketplace_query_orders').endpointMapping.queryParams).toEqual({
      orderStatusList: '$order_status_list',
      pageNum: '$page_num',
      pageSize: '$page_size',
    });
  });

  it('has no tool for returns, refunds or refund adjustments', () => {
    for (const entry of a.tools) expect(entry.endpointMapping.path).not.toMatch(/return|refund/i);
  });
});

// Opt-in: RUN_MICHAELS_MARKETPLACE_LIVE=1. Reads only; nothing is created or changed.
const live = process.env.RUN_MICHAELS_MARKETPLACE_LIVE === '1';
(live ? describe : describe.skip)('Michaels Marketplace: live', () => {
  const base = process.env.MICHAELS_API_URL ?? 'https://www.michaels.com/api/mkp/v1';
  const headers = () => {
    const key = process.env.MICHAELS_API_KEY;
    if (!key) throw new Error('Set MICHAELS_API_KEY for the live check');
    return { 'Api-Key': key, Accept: 'application/json' };
  };

  it('passes the authentication test', async () => {
    const response = await axios.get(`${base}/listing/authentication/test-auth`, { headers: headers(), validateStatus: () => true });
    expect(response.status).toBe(200);
  });

  it('reads one page of orders', async () => {
    const response = await axios.get(`${base}/order/query`, {
      headers: headers(),
      params: { pageNum: 1, pageSize: 5 },
      validateStatus: () => true,
    });
    expect(response.status).toBe(200);
    expect(response.data).toHaveProperty('data');
  });
});
