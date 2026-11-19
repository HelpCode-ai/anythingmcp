import axios from 'axios';
import * as adapter from './prodigi.json';

/**
 * Prodigi Print API v4 adapter.
 *
 * Static checks always run: the X-API-Key header, the live and sandbox
 * addresses offered as a choice, every tool's method and path against the
 * v4 documentation, the bodies of quotes and orders, and that everything
 * which costs money or changes an order (create, cancel, shipping method,
 * recipient) installs switched off.
 * https://www.prodigi.com/print-api/docs/v4/
 *
 * Live checks run only with RUN_PRODIGI_LIVE=1. Without credentials they
 * confirm that the sandbox refuses a wrong key; with PRODIGI_API_KEY (and
 * PRODIGI_API_URL, default the sandbox) they read one order page and one
 * product. Reads only: no quote and no order is created.
 *
 *   RUN_PRODIGI_LIVE=1 PRODIGI_API_KEY=... npx jest src/adapters/intl/prodigi.live.spec.ts
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
  prodigi_list_orders: ['GET', '/orders', []],
  prodigi_get_order: ['GET', '/orders/{order_id}', ['order_id']],
  prodigi_get_order_actions: ['GET', '/orders/{order_id}/actions', ['order_id']],
  prodigi_create_quote: ['POST', '/quotes', ['destination_country_code', 'items']],
  prodigi_get_product_details: ['GET', '/products/{sku}', ['sku']],
  prodigi_get_photobook_spine: ['POST', '/products/spine', ['sku', 'destination_country_code', 'number_of_pages']],
  prodigi_create_order: ['POST', '/orders', ['shipping_method', 'recipient', 'items']],
  prodigi_cancel_order: ['POST', '/orders/{order_id}/actions/cancel', ['order_id']],
  prodigi_update_shipping_method: ['POST', '/orders/{order_id}/actions/updateShippingMethod', ['order_id', 'shipping_method']],
  prodigi_update_recipient: ['POST', '/orders/{order_id}/actions/updateRecipient', ['order_id', 'recipient']],
  prodigi_update_metadata: ['POST', '/orders/{order_id}/actions/updateMetadata', ['order_id', 'metadata']],
};
/** Installed switched off: an order is produced and billed; cancelling and changing shipping or recipient cancel or re-price it. */
const SWITCHED_OFF: string[] = ['prodigi_create_order', 'prodigi_cancel_order', 'prodigi_update_shipping_method', 'prodigi_update_recipient'];
/** Tools on a write method that only read (searches and calculations). */
const POST_READS: string[] = ['prodigi_create_quote', 'prodigi_get_photobook_spine'];

describe('prodigi adapter: static contract', () => {
  it('is filed under intl/e-commerce with its own icon and documentation link', () => {
    expect(a.slug).toBe('prodigi');
    expect(a.name).toBe('Prodigi');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('e-commerce');
    expect(a.icon).toBe('prodigi');
    expect(a.docsUrl).toBe('https://www.prodigi.com/print-api/docs/v4/');
    expect(a.connector.type).toBe('REST');
  });

  it('sends the key in the X-API-Key header and offers live and sandbox', () => {
    expect(a.connector.baseUrl).toBe('{{PRODIGI_API_URL}}');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'X-API-Key', apiKey: '{{PRODIGI_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['PRODIGI_API_URL', 'PRODIGI_API_KEY']);
    expect(a.envVarMeta.PRODIGI_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const url = a.envVarMeta.PRODIGI_API_URL;
    expect(url.secret).toBeUndefined();
    expect(url.options?.map((option) => option.value)).toEqual([
      'https://api.prodigi.com/v4.0',
      'https://api.sandbox.prodigi.com/v4.0',
    ]);
    for (const option of url.options ?? []) expect(new RegExp(url.pattern!).test(option.value)).toBe(true);
    expect(new RegExp(url.pattern!).test('https://api.prodigi.com/v3.0')).toBe(false);
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
      expect(entry.name).toMatch(/^prodigi_[a-z0-9_]+$/);
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
    expect(a.instructions.startsWith('## Prodigi')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'prodigi_list_orders', params: { top: 1 } });
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const key of ['400', '401', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of a.requiredEnvVars) expect(a.envVarMeta[name]).toBeTruthy();
  });

  it('leaves only quotes, the spine calculation and metadata on among the POST tools', () => {
    const enabledPosts = a.tools
      .filter((entry) => entry.endpointMapping.method === 'POST' && entry.enabled !== false)
      .map((entry) => entry.name)
      .sort();
    expect(enabledPosts).toEqual(['prodigi_create_quote', 'prodigi_get_photobook_spine', 'prodigi_update_metadata']);
    expect(tool('prodigi_create_order').enabled).toBe(false);
    expect(tool('prodigi_create_order').description).toMatch(/charges your account/);
  });

  it('builds the quote and order bodies with the documented field names', () => {
    expect(tool('prodigi_create_quote').endpointMapping.bodyMapping).toEqual({
      shippingMethod: '$shipping_method',
      destinationCountryCode: '$destination_country_code',
      currencyCode: '$currency_code',
      items: '$items',
    });
    expect(tool('prodigi_create_order').endpointMapping.bodyMapping).toEqual({
      merchantReference: '$merchant_reference',
      shippingMethod: '$shipping_method',
      idempotencyKey: '$idempotency_key',
      callbackUrl: '$callback_url',
      recipient: '$recipient',
      items: '$items',
      metadata: '$metadata',
    });
    expect(tool('prodigi_update_shipping_method').endpointMapping.bodyMapping).toEqual({ shippingMethod: '$shipping_method' });
  });

  it('pages the order list with top and skip', () => {
    expect(tool('prodigi_list_orders').endpointMapping.queryParams).toMatchObject({ top: '$top', skip: '$skip', status: '$status' });
  });
});

// Opt-in: RUN_PRODIGI_LIVE=1. Reads only; nothing is created or changed.
const live = process.env.RUN_PRODIGI_LIVE === '1';
(live ? describe : describe.skip)('Prodigi: live', () => {
  const base = process.env.PRODIGI_API_URL ?? 'https://api.sandbox.prodigi.com/v4.0';

  it('refuses a wrong API key with 401', async () => {
    const response = await axios.get('https://api.sandbox.prodigi.com/v4.0/orders', {
      headers: { 'X-API-Key': 'not-a-real-key-000000000000' },
      params: { top: 1 },
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(response.data.outcome).toBe('NotAuthenticated');
  });

  it('reads one page of orders and one product', async () => {
    const key = process.env.PRODIGI_API_KEY;
    if (!key) throw new Error('Set PRODIGI_API_KEY for the live check');
    const headers = { 'X-API-Key': key, Accept: 'application/json' };
    const orders = await axios.get(`${base}/orders`, { headers, params: { top: 1 }, validateStatus: () => true });
    expect(orders.status).toBe(200);
    expect(Array.isArray(orders.data.orders)).toBe(true);
    const product = await axios.get(`${base}/products/GLOBAL-CAN-10x10`, { headers, validateStatus: () => true });
    expect(product.status).toBe(200);
  });
});
