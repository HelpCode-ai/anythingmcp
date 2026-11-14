import * as adapter from './daftra.json';

type Tool = {
  name: string;
  description: string;
  enabled?: boolean;
  parameters: { properties?: Record<string, unknown>; required?: string[] };
  endpointMapping: {
    method: string;
    path: string;
    queryParams?: Record<string, string>;
    bodyMapping?: Record<string, unknown>;
  };
};

const a = adapter as unknown as {
  slug: string;
  region: string;
  unlisted?: boolean;
  icon: string;
  instructions: string;
  requiredEnvVars: string[];
  envVarMeta: Record<string, { secret?: boolean; kind?: string; pattern?: string }>;
  probe: { tool: string };
  connector: {
    baseUrl: string;
    authType: string;
    authConfig: { headerName: string; apiKey: string };
    healthcheckPath: string;
  };
  tools: Tool[];
};
const byName = Object.fromEntries(a.tools.map((tool) => [tool.name, tool]));

describe('Daftra adapter — static contract', () => {
  it('calls the tenant api2 base URL with the APIKEY header', () => {
    expect(a.slug).toBe('daftra');
    expect(a.region).toBe('intl');
    expect(a.unlisted).toBeFalsy();
    expect(a.icon).toBe('daftra');
    expect(a.requiredEnvVars).toEqual(['DAFTRA_SUBDOMAIN', 'DAFTRA_API_KEY']);
    expect(a.connector.baseUrl).toBe('https://{{DAFTRA_SUBDOMAIN}}.daftra.com/api2');
    expect(a.connector.authType).toBe('API_KEY');
    expect(a.connector.authConfig).toEqual({ headerName: 'APIKEY', apiKey: '{{DAFTRA_API_KEY}}' });
    expect(a.envVarMeta.DAFTRA_API_KEY.secret).toBe(true);
    expect(a.envVarMeta.DAFTRA_SUBDOMAIN.kind).toBe('address');
    expect(new RegExp(a.envVarMeta.DAFTRA_SUBDOMAIN.pattern!).test('acme')).toBe(true);
    expect(new RegExp(a.envVarMeta.DAFTRA_SUBDOMAIN.pattern!).test('acme.daftra.com')).toBe(false);
  });

  it('checks the connection with a cheap authenticated GET', () => {
    expect(a.connector.healthcheckPath).toBe('/stores.json');
    expect(a.probe.tool).toBe('daftra_list_stores');
    expect(byName.daftra_list_stores.endpointMapping).toMatchObject({ method: 'GET', path: '/stores.json' });
  });

  // Daftra answers 405 to these with an API key (checked on a live account, 14 Oct 2026).
  it('has no tools for site info, incomes or taxes', () => {
    for (const path of ['/site_info.json', '/incomes.json', '/taxes.json']) {
      expect(a.tools.some((t) => t.endpointMapping.path === path)).toBe(false);
    }
  });

  it('maps the documented estimate routes (docs.daftara.dev, Sales > Estimates)', () => {
    expect(byName.daftra_list_estimates.endpointMapping).toEqual({
      method: 'GET',
      path: '/estimates.json',
      queryParams: {
        page: '$page',
        limit: '$limit',
        client_id: '$client_id',
        date_from: '$date_from',
        date_to: '$date_to',
        payment_status: '$payment_status',
        name: '$name',
      },
    });
    expect(byName.daftra_get_estimate.endpointMapping).toEqual({ method: 'GET', path: '/estimates/{id}.json' });
    expect(byName.daftra_get_estimate.parameters.required).toEqual(['id']);
    const create = byName.daftra_create_estimate as Tool & { annotations?: Record<string, boolean> };
    expect(create.endpointMapping).toEqual({
      method: 'POST',
      path: '/estimates.json',
      bodyMapping: { Invoice: '$Invoice', InvoiceItem: '$InvoiceItem' },
    });
    expect(create.parameters.required).toEqual(['Invoice', 'InvoiceItem']);
    expect(create.annotations).toEqual({ readOnlyHint: false, destructiveHint: false });
    expect(create.enabled).toBeUndefined();
    expect(a.instructions).toContain('estimates (quotations)');
    expect(a.instructions).toContain('`daftra_create_estimate`');
  });

  it('prefixes every tool and uses the .json resource paths', () => {
    for (const tool of a.tools) {
      expect(tool.name.startsWith('daftra_')).toBe(true);
      expect(tool.endpointMapping.path).toMatch(/\.json$/);
      expect(tool.description.length).toBeGreaterThanOrEqual(60);
    }
  });

  it('pages list tools with page and limit', () => {
    const lists = a.tools.filter((tool) => tool.name.startsWith('daftra_list_'));
    expect(lists).toHaveLength(17);
    for (const tool of lists) {
      expect(tool.endpointMapping.method).toBe('GET');
      expect(tool.endpointMapping.queryParams).toMatchObject({ page: '$page', limit: '$limit' });
    }
    expect(byName.daftra_list_invoices.endpointMapping.queryParams).toMatchObject({
      client_id: '$client_id',
      date_from: '$date_from',
      date_to: '$date_to',
      payment_status: '$payment_status',
    });
  });

  it('wraps write bodies in the Daftra model envelope', () => {
    expect(byName.daftra_create_invoice.endpointMapping.bodyMapping).toEqual({ Invoice: '$Invoice', InvoiceItem: '$InvoiceItem' });
    expect(byName.daftra_create_purchase_invoice.endpointMapping.bodyMapping).toEqual({
      PurchaseOrder: '$PurchaseOrder',
      PurchaseOrderItem: '$PurchaseOrderItem',
    });
    expect(byName.daftra_create_journal.endpointMapping.bodyMapping).toEqual({ Journal: '$Journal', JournalTransaction: '$JournalTransaction' });
    expect(byName.daftra_create_client.endpointMapping.bodyMapping).toMatchObject({ Client: { business_name: '$business_name' } });
    expect(byName.daftra_create_invoice_payment.endpointMapping.bodyMapping).toMatchObject({
      InvoicePayment: { invoice_id: '$invoice_id', amount: '$amount' },
    });
    expect(byName.daftra_update_product.endpointMapping).toMatchObject({ method: 'PUT', path: '/products/{id}.json' });
    expect(byName.daftra_update_journal.endpointMapping).toEqual({
      method: 'PUT',
      path: '/journals/{id}.json',
      bodyMapping: { Journal: '$Journal', JournalTransaction: '$JournalTransaction' },
    });
    expect(byName.daftra_update_journal.parameters.required).toEqual(['id', 'Journal', 'JournalTransaction']);
    expect(byName.daftra_create_treasury.endpointMapping).toMatchObject({
      method: 'POST',
      path: '/treasuries.json',
      bodyMapping: { Treasury: { name: '$name', type: '$type', active: '$active', currency_code: '$currency_code' } },
    });
    expect(byName.daftra_create_journal_category.endpointMapping).toEqual({
      method: 'POST',
      path: '/journal_cats.json',
      bodyMapping: { JournalCat: { name: '$name', code: '$code', journal_cat_id: '$journal_cat_id', type: '$type' } },
    });
  });

  it('maps the invoice draft switch, a GET that writes, as a write', () => {
    const tool = byName.daftra_set_invoice_draft_status as Tool & { annotations?: Record<string, boolean> };
    expect(tool.endpointMapping).toEqual({ method: 'GET', path: '/invoices/update_draft/{id}/{draft_status}.json' });
    expect(tool.parameters.required).toEqual(['id', 'draft_status']);
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    expect(tool.description).toMatch(/confirm/i);
  });

  it('asks for confirmation on writes and installs deletes switched off', () => {
    const writes = a.tools.filter((tool) => tool.endpointMapping.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const tool of writes) expect(tool.description).toMatch(/confirm/i);
    const deletes = a.tools.filter((tool) => tool.endpointMapping.method === 'DELETE');
    expect(deletes.map((tool) => tool.name).sort()).toEqual([
      'daftra_delete_expense',
      'daftra_delete_invoice',
      'daftra_delete_invoice_payment',
      'daftra_delete_journal',
    ]);
    for (const tool of deletes) expect(tool.enabled).toBe(false);
    // Rewriting a posted journal and issuing an invoice are hard to undo: off as well.
    const offWrites = ['daftra_update_journal', 'daftra_set_invoice_draft_status'];
    for (const name of offWrites) expect(byName[name].enabled).toBe(false);
    for (const tool of a.tools.filter((t) => t.endpointMapping.method !== 'DELETE' && !offWrites.includes(t.name))) {
      expect(tool.enabled).not.toBe(false);
    }
  });

  it('keeps the instructions free of em dashes and within the house limits', () => {
    expect(a.instructions.length).toBeGreaterThanOrEqual(800);
    expect(a.instructions.length).toBeLessThanOrEqual(2500);
    expect(a.instructions).not.toMatch(/—/);
    expect(a.instructions).toContain('**Getting credentials');
  });
});

// Opt-in: run with RUN_DAFTRA_LIVE=1, DAFTRA_SUBDOMAIN and DAFTRA_API_KEY. Read-only calls only.
const live = process.env.RUN_DAFTRA_LIVE === '1';
(live ? describe : describe.skip)('Daftra — live read-only smoke test', () => {
  const sub = process.env.DAFTRA_SUBDOMAIN;
  const key = process.env.DAFTRA_API_KEY;
  const get = async (path: string) => {
    if (!sub || !key) throw new Error('Set DAFTRA_SUBDOMAIN and DAFTRA_API_KEY for RUN_DAFTRA_LIVE=1');
    return fetch(`https://${sub}.daftra.com/api2${path}`, { headers: { APIKEY: key, Accept: 'application/json' } });
  };

  it('reads the warehouses', async () => {
    const res = await get('/stores.json');
    expect(res.status).toBe(200);
    expect(typeof (await res.json())).toBe('object');
  });

  it('pages invoices and clients', async () => {
    for (const path of ['/invoices.json?page=1&limit=1', '/clients.json?page=1&limit=1']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Array.isArray(body.data)).toBe(true);
    }
  });

  it('pages estimates', async () => {
    const res = await get('/estimates.json?page=1&limit=1');
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).data)).toBe(true);
  });
});
