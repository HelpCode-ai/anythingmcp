import axios from 'axios';
import * as adapter from './ro-app.json';

/**
 * RO App (formerly RemOnline) Public API v2 adapter.
 *
 * Static checks always run: the bearer API key on https://api.roapp.io/v2
 * (v2 has no token exchange), every tool's method and path against the
 * OpenAPI definitions of the RO App reference, the write bodies, the old
 * name as an alias, and that finance and invoices are read-only and nothing
 * is deleted.
 * https://roapp.readme.io/reference/getting-started-with-api
 *
 * Live checks run only with RUN_RO_APP_LIVE=1. Without credentials they
 * confirm that a wrong key is refused (RO App answers 403 "Invalid token");
 * with RO_APP_API_KEY they read the company and the order statuses. Reads
 * only; RO App allows 3 requests per second.
 *
 *   RUN_RO_APP_LIVE=1 RO_APP_API_KEY=... npx jest src/adapters/intl/ro-app.live.spec.ts
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
  ro_app_get_company: ['GET', '/company', []],
  ro_app_list_locations: ['GET', '/company/locations', []],
  ro_app_list_employees: ['GET', '/company/employees', []],
  ro_app_list_orders: ['GET', '/orders', []],
  ro_app_get_order: ['GET', '/orders/{order_id}', ['order_id']],
  ro_app_list_order_items: ['GET', '/orders/{order_id}/items', ['order_id']],
  ro_app_create_order: ['POST', '/orders', ['branch_id', 'order_type_id', 'client_id']],
  ro_app_update_order: ['PATCH', '/orders/{order_id}', ['order_id']],
  ro_app_update_order_status: ['POST', '/orders/{order_id}/status', ['order_id', 'status_id']],
  ro_app_add_order_comment: ['POST', '/orders/{order_id}/comments', ['order_id', 'comment']],
  ro_app_list_order_statuses: ['GET', '/orders/statuses', []],
  ro_app_list_order_types: ['GET', '/orders/types', []],
  ro_app_list_people: ['GET', '/contacts/people', []],
  ro_app_get_person: ['GET', '/contacts/people/{person_id}', ['person_id']],
  ro_app_create_person: ['POST', '/contacts/people', ['first_name']],
  ro_app_list_organizations: ['GET', '/contacts/organizations', []],
  ro_app_get_organization: ['GET', '/contacts/organizations/{organization_id}', ['organization_id']],
  ro_app_create_organization: ['POST', '/contacts/organizations', ['name']],
  ro_app_list_inquiries: ['GET', '/inquiries', []],
  ro_app_get_inquiry: ['GET', '/inquiries/{inquiry_id}', ['inquiry_id']],
  ro_app_create_inquiry: ['POST', '/inquiries', ['type_id']],
  ro_app_update_inquiry_status: ['POST', '/inquiries/{inquiry_id}/status', ['inquiry_id', 'status_id']],
  ro_app_list_inquiry_statuses: ['GET', '/inquiries/statuses', []],
  ro_app_list_inquiry_types: ['GET', '/inquiries/types', []],
  ro_app_list_products: ['GET', '/catalog/products', []],
  ro_app_get_product: ['GET', '/catalog/products/{product_id}', ['product_id']],
  ro_app_list_warehouses: ['GET', '/assets/warehouses', []],
  ro_app_list_invoices: ['GET', '/invoices', []],
  ro_app_get_invoice: ['GET', '/invoices/{invoice_id}', ['invoice_id']],
  ro_app_list_invoice_items: ['GET', '/invoices/{invoice_id}/items', ['invoice_id']],
  ro_app_list_finance_accounts: ['GET', '/finance/accounts', []],
  ro_app_list_account_transactions: ['GET', '/finance/accounts/{account_id}/transactions', ['account_id']],
  ro_app_list_tasks: ['GET', '/tasks', []],
  ro_app_get_task: ['GET', '/tasks/{task_id}', ['task_id']],
  ro_app_create_task: ['POST', '/tasks', ['title', 'due_date']],
};
/** Installed switched off: nothing: the adapter has no delete, payment or refund tool. */
const SWITCHED_OFF: string[] = [];
/** Tools on a write method that only read (searches and calculations). */
const POST_READS: string[] = [];

describe('ro-app adapter: static contract', () => {
  it('is filed under intl/crm with its own icon and documentation link', () => {
    expect(a.slug).toBe('ro-app');
    expect(a.name).toBe('RO App');
    expect(a.region).toBe('intl');
    expect(a.category).toBe('crm');
    expect(a.icon).toBe('ro-app');
    expect(a.docsUrl).toBe('https://roapp.readme.io/reference/getting-started-with-api');
    expect(a.connector.type).toBe('REST');
  });

  it('sends the API key as a bearer token to API v2', () => {
    expect(a.connector.baseUrl).toBe('https://api.roapp.io/v2');
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig).toEqual({ token: '{{RO_APP_API_KEY}}' });
    expect(a.requiredEnvVars).toEqual(['RO_APP_API_KEY']);
    expect(a.envVarMeta.RO_APP_API_KEY).toMatchObject({ kind: 'credential', secret: true });
    const pattern = new RegExp(a.envVarMeta.RO_APP_API_KEY.pattern!);
    expect(pattern.test('946389976c464478beb0cf7a7b5b01bb')).toBe(true);
    expect(pattern.test('Bearer 946389976c464478beb0cf7a7b5b01bb')).toBe(false);
  });

  it('can be found under its former name RemOnline', () => {
    expect(a.aliases).toContain('RemOnline');
    expect(a.instructions).toContain('RemOnline');
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
      expect(entry.name).toMatch(/^ro_app_[a-z0-9_]+$/);
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
    expect(a.instructions.startsWith('## RO App')).toBe(true);
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
  });

  it('checks the credentials with a cheap read and explains the usual refusals', () => {
    expect(a.probe).toEqual({ tool: 'ro_app_get_company', params: {} });
    expect(tool(a.probe.tool).annotations?.readOnlyHint).toBe(true);
    for (const key of ['400', '401', '403', '404', 'rate_limited']) expect(a.verifyHints[key]).toBeTruthy();
    for (const name of a.requiredEnvVars) expect(a.envVarMeta[name]).toBeTruthy();
  });

  it('reads invoices and finance without writing, and deletes nothing', () => {
    for (const entry of a.tools) {
      const path = entry.endpointMapping.path;
      if (path.startsWith('/invoices') || path.startsWith('/finance')) {
        expect([entry.name, entry.endpointMapping.method]).toEqual([entry.name, 'GET']);
      }
      expect([entry.name, entry.endpointMapping.method === 'DELETE']).toEqual([entry.name, false]);
      expect(path).not.toMatch(/transfer|refund|merge/);
    }
    expect(SWITCHED_OFF).toEqual([]);
  });

  it('creates orders, inquiries and tasks with the documented fields', () => {
    expect(tool('ro_app_create_order').parameters.required).toEqual(['branch_id', 'order_type_id', 'client_id']);
    expect(tool('ro_app_create_order').endpointMapping.bodyMapping).toMatchObject({
      branch_id: '$branch_id',
      order_type_id: '$order_type_id',
      client_id: '$client_id',
      malfunction: '$malfunction',
      status_id: '$status_id',
    });
    expect(tool('ro_app_update_order_status').endpointMapping.bodyMapping).toEqual({ status_id: '$status_id', comment: '$comment' });
    expect(tool('ro_app_create_inquiry').parameters.required).toEqual(['type_id']);
    expect(tool('ro_app_create_task').endpointMapping.bodyMapping).toEqual({
      title: '$title',
      due_date: '$due_date',
      description: '$description',
      priority: '$priority',
      assignee_ids: '$assignee_ids',
      related_object: '$related_object',
    });
  });

  it('filters lists by ids and date ranges under the parameter names of the API', () => {
    const query = tool('ro_app_list_orders').endpointMapping.queryParams ?? {};
    expect(query).toMatchObject({ statuses: '$statuses', client_ids: '$client_ids', created_at: '$created_at', page: '$page' });
    // The inquiry list spells this filter clients_ids.
    expect(tool('ro_app_list_inquiries').endpointMapping.queryParams).toMatchObject({ clients_ids: '$clients_ids' });
  });
});

// Opt-in: RUN_RO_APP_LIVE=1. Reads only; nothing is created or changed.
const live = process.env.RUN_RO_APP_LIVE === '1';
(live ? describe : describe.skip)('RO App: live', () => {
  const base = 'https://api.roapp.io/v2';

  it('refuses a wrong API key', async () => {
    const response = await axios.get(`${base}/company`, {
      headers: { Authorization: 'Bearer 00000000000000000000000000000000' },
      validateStatus: () => true,
    });
    // RO App answers 403 with "Invalid token" rather than 401.
    expect([401, 403]).toContain(response.status);
  });

  it('reads the company and the order statuses', async () => {
    const key = process.env.RO_APP_API_KEY;
    if (!key) throw new Error('Set RO_APP_API_KEY for the live check');
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const company = await axios.get(`${base}/company`, { headers, validateStatus: () => true });
    expect(company.status).toBe(200);
    const statuses = await axios.get(`${base}/orders/statuses`, { headers, validateStatus: () => true });
    expect(statuses.status).toBe(200);
  });
});
