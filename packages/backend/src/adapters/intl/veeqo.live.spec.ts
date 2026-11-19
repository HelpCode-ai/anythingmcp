import axios from 'axios';
import * as adapter from './veeqo.json';

/**
 * Veeqo API adapter (https://api.veeqo.com).
 *
 * Static checks always run: the x-api-key header, every tool's method and
 * path against the Veeqo API reference, the envelopes of the write bodies
 * (order, allocation, shipment, stock_entry, product, purchase_order,
 * customer), and that cancelling an order and deleting a shipment install
 * switched off. No tool buys shipping labels or rates.
 * https://developers.veeqo.com/api/
 *
 * Live checks run only with RUN_VEEQO_LIVE=1. Without credentials they
 * confirm that a wrong key is refused; with VEEQO_API_KEY they read the
 * company and one page of orders. Reads only.
 *
 *   RUN_VEEQO_LIVE=1 VEEQO_API_KEY=... npx jest src/adapters/intl/veeqo.live.spec.ts
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
  veeqo_get_company: ['GET', '/current_company', []],
  veeqo_list_orders: ['GET', '/orders', []],
  veeqo_get_order: ['GET', '/orders/{order_id}', ['order_id']],
  veeqo_create_order: ['POST', '/orders', ['channel_id', 'customer_id', 'delivery_method_id', 'line_items']],
  veeqo_update_order: ['PUT', '/orders/{order_id}', ['order_id']],
  veeqo_add_order_note: ['POST', '/orders/{order_id}/notes', ['order_id', 'text']],
  veeqo_cancel_order: ['PUT', '/orders/{order_id}/cancel', ['order_id']],
  veeqo_create_allocation: ['POST', '/orders/{order_id}/allocations', ['order_id', 'warehouse_id', 'line_items']],
  veeqo_create_shipment: ['POST', '/shipments', ['order_id', 'allocation_id', 'carrier_id', 'tracking_number']],
  veeqo_delete_shipment: ['DELETE', '/shipments/{shipment_id}', ['shipment_id']],
  veeqo_get_tracking_events: ['GET', '/shipping/tracking_events/{shipment_id}', ['shipment_id']],
  veeqo_list_products: ['GET', '/products', []],
  veeqo_get_product: ['GET', '/products/{product_id}', ['product_id']],
  veeqo_create_product: ['POST', '/products', ['title', 'product_variants']],
  veeqo_update_product: ['PUT', '/products/{product_id}', ['product_id']],
  veeqo_get_stock_entry: ['GET', '/sellables/{sellable_id}/warehouses/{warehouse_id}/stock_entry', ['sellable_id', 'warehouse_id']],
  veeqo_update_stock_entry: ['PUT', '/sellables/{sellable_id}/warehouses/{warehouse_id}/stock_entry', ['sellable_id', 'warehouse_id', 'physical_stock_level']],
  veeqo_list_warehouses: ['GET', '/warehouses', []],
  veeqo_get_warehouse: ['GET', '/warehouses/{warehouse_id}', ['warehouse_id']],
  veeqo_list_purchase_orders: ['GET', '/purchase_orders', []],
  veeqo_get_purchase_order: ['GET', '/purchase_orders/{purchase_order_id}', ['purchase_order_id']],
  veeqo_create_purchase_order: ['POST', '/purchase_orders', ['supplier_id', 'destination_warehouse_id', 'line_items']],
  veeqo_list_customers: ['GET', '/customers', []],
  veeqo_get_customer: ['GET', '/customers/{customer_id}', ['customer_id']],
  veeqo_create_customer: ['POST', '/customers', ['email', 'customer_type']],
  veeqo_update_customer: ['PUT', '/customers/{customer_id}', ['customer_id']],
  veeqo_list_suppliers: ['GET', '/suppliers', []],
  veeqo_get_supplier: ['GET', '/suppliers/{supplier_id}', ['supplier_id']],
  veeqo_create_supplier: ['POST', '/suppliers', ['name']],
  veeqo_list_stores: ['GET', '/channels', []],
  veeqo_list_delivery_methods: ['GET', '/delivery_methods', []],
};
/** Installed switched off: cancelling an order and deleting a shipment undo work that reached customers and sales channels. */
const SWITCHED_OFF: string[] = ['veeqo_cancel_order', 'veeqo_delete_shipment'];
/** Tools on a write method that only read (searches and calculations). */
const POST_READS: string[] = [];

describe('veeqo adapter: static contract', () => {
  it('is filed under intl/e-commerce with its own icon and documentation link', () => {
    expect(a.slug).toBe('veeqo');
    expect(a.name).toBe('Veeqo');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('veeqo');
    expect(a.docsUrl).toBe('https://developers.veeqo.com/api/');
    expect(a.connector.type).toBe('REST');
  });

  it('sends the key in the x-api-key header', () => {
    expect(a.connector.baseUrl).toBe('https://api.veeqo.com');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'x-api-key', apiKey: '{{VEEQO_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['VEEQO_API_KEY']);
    expect(a.envVarMeta.VEEQO_API_KEY).toMatchObject({ kind: 'credential', secret: true });
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
      expect(entry.name).toMatch(/^veeqo_[a-z0-9_]+$/);
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
    expect(a.instructions.startsWith('## Veeqo')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'veeqo_get_company', params: {} });
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of a.requiredEnvVars) expect(a.envVarMeta[name]).toBeTruthy();
  });

  it('wraps the write bodies in the envelopes Veeqo documents', () => {
    const body = (name: string) => tool(name).endpointMapping.bodyMapping as Record<string, unknown>;
    expect(Object.keys(body('veeqo_create_order'))).toEqual(['order']);
    expect(Object.keys(body('veeqo_update_order'))).toEqual(['order']);
    expect(Object.keys(body('veeqo_create_product'))).toEqual(['product']);
    expect(Object.keys(body('veeqo_update_product'))).toEqual(['product']);
    expect(Object.keys(body('veeqo_create_customer'))).toEqual(['customer']);
    expect(Object.keys(body('veeqo_create_purchase_order'))).toEqual(['purchase_order']);
    expect(body('veeqo_add_order_note')).toEqual({ note: { text: '$text' } });
    expect(body('veeqo_update_stock_entry')).toEqual({
      stock_entry: { physical_stock_level: '$physical_stock_level', infinite: '$infinite', location: '$location' },
    });
    expect(body('veeqo_create_allocation')).toEqual({
      allocation: { warehouse_id: '$warehouse_id', line_items_attributes: '$line_items', packed_completely: '$packed_completely' },
    });
  });

  it('records a shipment with carrier and tracking number, without buying a label', () => {
    expect(tool('veeqo_create_shipment').endpointMapping.bodyMapping).toEqual({
      shipment: {
        tracking_number_attributes: { tracking_number: '$tracking_number' },
        carrier_id: '$carrier_id',
        shipment_extra_attributes: '$shipment_extra_attributes',
        notify_customer: '$notify_customer',
        update_remote_order: '$update_remote_order',
      },
      allocation_id: '$allocation_id',
      order_id: '$order_id',
    });
    for (const entry of a.tools) {
      expect(entry.endpointMapping.path).not.toMatch(/rates|labels|purchase_shipping|shipping\/shipments/);
    }
  });

  it('filters orders with the bracketed parameter names of the API', () => {
    const query = tool('veeqo_list_orders').endpointMapping.queryParams ?? {};
    expect(query['created[after]']).toBe('$created_after');
    expect(query['created[before]']).toBe('$created_before');
    expect(query['order_ids[]']).toBe('$order_ids');
    expect(query['channel_ids[]']).toBe('$channel_ids');
  });
});

// Opt-in: RUN_VEEQO_LIVE=1. Reads only; nothing is created or changed.
const live = process.env.RUN_VEEQO_LIVE === '1';
(live ? describe : describe.skip)('Veeqo: live', () => {
  const base = 'https://api.veeqo.com';

  it('refuses a wrong API key with 401', async () => {
    const response = await axios.get(`${base}/current_company`, {
      headers: { 'x-api-key': 'not-a-real-key-000000000000' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
  });

  it('reads the company and one page of orders', async () => {
    const key = process.env.VEEQO_API_KEY;
    if (!key) throw new Error('Set VEEQO_API_KEY for the live check');
    const headers = { 'x-api-key': key, Accept: 'application/json' };
    const company = await axios.get(`${base}/current_company`, { headers, validateStatus: () => true });
    expect(company.status).toBe(200);
    const orders = await axios.get(`${base}/orders`, { headers, params: { page_size: 1 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data)).toBe(true);
  });
});
