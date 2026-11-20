import axios from 'axios';
import * as adapter from './moysklad.json';

/**
 * MoySklad JSON API 1.2 adapter.
 *
 * Static checks always run: the bearer token, the two headers MoySklad
 * insists on (Accept-Encoding: gzip, without which it answers 415, and
 * Accept: application/json;charset=utf-8), every tool's method and path
 * against the JSON API 1.2 documentation, the 1000-row page limit, the meta
 * references a customer order is built with, and that nothing is deleted.
 * https://dev.moysklad.ru/doc/api/remap/1.2/
 *
 * Live checks run only with RUN_MOYSKLAD_LIVE=1. Without credentials they
 * confirm the gzip rule and that a wrong token is refused; with
 * MOYSKLAD_TOKEN they read the employee context and one store. Reads only.
 *
 *   RUN_MOYSKLAD_LIVE=1 MOYSKLAD_TOKEN=... npx jest src/adapters/intl/moysklad.live.spec.ts
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
  moysklad_get_employee_context: ['GET', '/context/employee', []],
  moysklad_list_assortment: ['GET', '/entity/assortment', []],
  moysklad_list_products: ['GET', '/entity/product', []],
  moysklad_get_product: ['GET', '/entity/product/{product_id}', ['product_id']],
  moysklad_create_product: ['POST', '/entity/product', ['name']],
  moysklad_update_product: ['PUT', '/entity/product/{product_id}', ['product_id']],
  moysklad_list_product_folders: ['GET', '/entity/productfolder', []],
  moysklad_get_stock_report: ['GET', '/report/stock/all', []],
  moysklad_get_stock_by_store: ['GET', '/report/stock/bystore', []],
  moysklad_get_current_stock: ['GET', '/report/stock/{scope}/current', ['scope']],
  moysklad_list_counterparties: ['GET', '/entity/counterparty', []],
  moysklad_get_counterparty: ['GET', '/entity/counterparty/{counterparty_id}', ['counterparty_id']],
  moysklad_create_counterparty: ['POST', '/entity/counterparty', ['name']],
  moysklad_update_counterparty: ['PUT', '/entity/counterparty/{counterparty_id}', ['counterparty_id']],
  moysklad_list_customer_orders: ['GET', '/entity/customerorder', []],
  moysklad_get_customer_order: ['GET', '/entity/customerorder/{order_id}', ['order_id']],
  moysklad_get_customer_order_metadata: ['GET', '/entity/customerorder/metadata', []],
  moysklad_create_customer_order: ['POST', '/entity/customerorder', ['organization_id', 'agent_id', 'positions']],
  moysklad_update_customer_order: ['PUT', '/entity/customerorder/{order_id}', ['order_id']],
  moysklad_list_demands: ['GET', '/entity/demand', []],
  moysklad_get_demand: ['GET', '/entity/demand/{demand_id}', ['demand_id']],
  moysklad_list_supplies: ['GET', '/entity/supply', []],
  moysklad_get_supply: ['GET', '/entity/supply/{supply_id}', ['supply_id']],
  moysklad_list_invoices_out: ['GET', '/entity/invoiceout', []],
  moysklad_get_invoice_out: ['GET', '/entity/invoiceout/{invoice_id}', ['invoice_id']],
  moysklad_list_stores: ['GET', '/entity/store', []],
  moysklad_list_organizations: ['GET', '/entity/organization', []],
  moysklad_get_profit_by_product: ['GET', '/report/profit/byproduct', []],
  moysklad_get_profit_by_counterparty: ['GET', '/report/profit/bycounterparty', []],
  moysklad_get_turnover: ['GET', '/report/turnover/all', []],
  moysklad_get_dashboard: ['GET', '/report/dashboard/{period}', ['period']],
};
/** Installed switched off: nothing: the adapter has no delete, cancel or payment tool. */
const SWITCHED_OFF: string[] = [];
/** Tools on a write method that only read (searches and calculations). */
const POST_READS: string[] = [];

describe('moysklad adapter: static contract', () => {
  it('is filed under intl/erp with its own icon and documentation link', () => {
    expect(a.slug).toBe('moysklad');
    expect(a.name).toBe('MoySklad');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('erp');
    expect(a.icon).toBe('moysklad');
    expect(a.docsUrl).toBe('https://dev.moysklad.ru/doc/api/remap/1.2/');
    expect(a.connector.type).toBe('REST');
  });

  it('sends the bearer token with gzip and the JSON media type MoySklad requires', () => {
    expect(a.connector.baseUrl).toBe('https://api.moysklad.ru/api/remap/1.2');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{MOYSKLAD_TOKEN}}' });
    // Without Accept-Encoding: gzip the API answers 415 with no body; any
    // Accept other than this one is refused with error 1062.
    expect(a.connector.headers).toMatchObject({
      'Accept-Encoding': 'gzip',
      Accept: 'application/json;charset=utf-8',
    });
    expect(a.requiredEnvVars).toEqual(['MOYSKLAD_TOKEN']);
    expect(a.envVarMeta.MOYSKLAD_TOKEN).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.MOYSKLAD_TOKEN.pattern!);
    expect(pattern.test('0cbfc512618efa7d5fa306250bca064c1169b37c')).toBe(true);
    expect(pattern.test('Bearer 0cbfc512618efa7d5fa306250bca064c1169b37c')).toBe(false);
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
      expect(entry.name).toMatch(/^moysklad_[a-z0-9_]+$/);
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
    expect(a.instructions.startsWith('## MoySklad')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'moysklad_get_employee_context', params: {} });
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of a.requiredEnvVars) expect(a.envVarMeta[name]).toBeTruthy();
  });

  it('never asks for more than 1000 rows and pages with limit and offset', () => {
    const lists = a.tools.filter((entry) => entry.parameters.properties?.limit);
    expect(lists.length).toBeGreaterThanOrEqual(15);
    for (const entry of lists) {
      const limit = entry.parameters.properties!.limit;
      expect([entry.name, limit.maximum]).toEqual([entry.name, 1000]);
      expect([entry.name, limit.default]).toEqual([entry.name, 100]);
      expect(entry.endpointMapping.queryParams).toMatchObject({ limit: '$limit', offset: '$offset' });
    }
    expect(a.instructions).toMatch(/at most 1000 rows/);
  });

  it('builds a customer order from meta references to the organization and the counterparty', () => {
    const body = tool('moysklad_create_customer_order').endpointMapping.bodyMapping as Record<string, unknown>;
    expect(body.organization).toEqual({
      meta: {
        href: 'https://api.moysklad.ru/api/remap/1.2/entity/organization/${organization_id}',
        type: 'organization',
        mediaType: 'application/json',
      },
    });
    expect(body.agent).toEqual({
      meta: {
        href: 'https://api.moysklad.ru/api/remap/1.2/entity/counterparty/${agent_id}',
        type: 'counterparty',
        mediaType: 'application/json',
      },
    });
    expect(body.positions).toBe('$positions');
    expect(tool('moysklad_create_customer_order').parameters.required).toEqual(['organization_id', 'agent_id', 'positions']);
  });

  it('writes only products, counterparties and customer orders, and deletes nothing', () => {
    const writes = a.tools.filter((entry) => entry.endpointMapping.method !== 'GET').map((entry) => entry.name);
    expect(writes.sort()).toEqual([
      'moysklad_create_counterparty',
      'moysklad_create_customer_order',
      'moysklad_create_product',
      'moysklad_update_counterparty',
      'moysklad_update_customer_order',
      'moysklad_update_product',
    ]);
    for (const entry of a.tools) expect(entry.endpointMapping.path).not.toMatch(/payment|cashin|cashout|delete/i);
  });

  it('reads the short stock report for all stores or per store', () => {
    const entry = tool('moysklad_get_current_stock');
    expect(entry.endpointMapping.path).toBe('/report/stock/{scope}/current');
    expect(entry.parameters.properties!.scope.enum).toEqual(['all', 'bystore']);
  });
});

// Opt-in: RUN_MOYSKLAD_LIVE=1. Reads only; nothing is created or changed.
const live = process.env.RUN_MOYSKLAD_LIVE === '1';
(live ? describe : describe.skip)('MoySklad: live', () => {
  const base = 'https://api.moysklad.ru/api/remap/1.2';
  const headers = (token: string) => ({
    Authorization: `Bearer ${token}`,
    'Accept-Encoding': 'gzip',
    Accept: 'application/json;charset=utf-8',
  });

  it('refuses a wrong token with 401 and error code 1056', async () => {
    const response = await axios.get(`${base}/context/employee`, {
      headers: headers('0000000000000000000000000000000000000000'),
      validateStatus: () => true,
    });
    expect(response.status).toBe(401);
    expect(response.data.errors[0].code).toBe(1056);
  });

  it('answers 415 when gzip is not accepted', async () => {
    const response = await axios.get(`${base}/context/employee`, {
      headers: { Authorization: 'Bearer 0000000000000000000000000000000000000000', 'Accept-Encoding': 'identity' },
      validateStatus: () => true,
    });
    expect(response.status).toBe(415);
  });

  it('reads the employee context and one store', async () => {
    const token = process.env.MOYSKLAD_TOKEN;
    if (!token) throw new Error('Set MOYSKLAD_TOKEN for the live check');
    const context = await axios.get(`${base}/context/employee`, { headers: headers(token), validateStatus: () => true });
    expect(context.status).toBe(200);
    const stores = await axios.get(`${base}/entity/store`, { headers: headers(token), params: { limit: 1 }, validateStatus: () => true });
    expect(stores.status).toBe(200);
    expect(Array.isArray(stores.data.rows)).toBe(true);
  });
});
