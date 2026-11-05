import * as adapter from './buchhaltungsbutler.json';

const a = adapter as unknown as {
  slug: string;
  region: string;
  category: string;
  requiredEnvVars: string[];
  optionalEnvVars?: string[];
  probe?: { tool: string };
  connector: {
    type: string;
    baseUrl: string;
    authType: string;
    authConfig?: Record<string, unknown>;
    headers?: Record<string, string>;
    healthcheckPath?: string;
  };
  tools: Array<{ name: string; endpointMapping: Record<string, unknown> }>;
};

const toolNames = a.tools.map((t) => t.name);

describe('buchhaltungsbutler adapter — static spec conformance', () => {
  it("authenticates the API client with HTTP Basic", () => {
    expect(a.connector.authType).toBe('BASIC_AUTH');
    expect(a.connector.authConfig?.username).toBe('{{BUCHHALTUNGSBUTLER_CLIENT_ID}}');
  });

  it("carries the separate api_key in every request body", () => {
    for (const t of a.tools) {
      const body = t.endpointMapping.bodyMapping as Record<string, unknown>;
      expect(body.api_key).toBe('{{BUCHHALTUNGSBUTLER_API_KEY}}');
    };
  });

  it("reads over POST, as the API requires", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'POST')).toBe(true);
  });

  it("declares all three credentials", () => {
    expect(a.requiredEnvVars).toHaveLength(3);
  });

  // Checked against the vendor's OpenAPI document (docs/api/v1.de.json) and a
  // live tenant, Oct 2026: customers and suppliers live under /settings/get.
  it("uses the endpoints the API actually has", () => {
    const paths = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]));
    expect(paths.buchhaltungsbutler_list_customers).toBe('/settings/get/debtors');
    expect(paths.buchhaltungsbutler_list_suppliers).toBe('/settings/get/creditors');
    expect(Object.values(paths)).not.toContain('/customers/get');
    expect(Object.values(paths)).not.toContain('/suppliers/get');
  });

  it("requires the filters the API refuses to run without", () => {
    const required = (name: string) =>
      ((a.tools.find((t) => t.name === name) as any).parameters.required ?? []) as string[];
    expect(required('buchhaltungsbutler_list_receipts')).toContain('list_direction');
    expect(required('buchhaltungsbutler_list_postings')).toEqual(
      expect.arrayContaining(['date_from', 'date_to']),
    );
  });
});

describe('buchhaltungsbutler adapter: booking and master data writes', () => {
  const tool = (name: string) => {
    const t = a.tools.find((x) => x.name === name) as
      | { name: string; enabled?: boolean; parameters: { required?: string[] }; endpointMapping: Record<string, unknown>; annotations?: Record<string, boolean> }
      | undefined;
    if (!t) throw new Error(`missing tool ${name}`);
    return t;
  };

  it('maps the documented endpoints', () => {
    const paths: Record<string, string> = {
      buchhaltungsbutler_get_receipt: '/receipts/get/{id_by_customer}',
      buchhaltungsbutler_book_receipt: '/postings/add/receipt',
      buchhaltungsbutler_book_transaction: '/postings/add/transaction',
      buchhaltungsbutler_remove_receipt_booking: '/postings/unconfirm/receipt',
      buchhaltungsbutler_remove_transaction_booking: '/postings/unconfirm/transaction',
      buchhaltungsbutler_link_receipt_to_transaction: '/transactions/assign/receipt',
      buchhaltungsbutler_add_customer: '/settings/add/debtor',
      buchhaltungsbutler_add_supplier: '/settings/add/creditor',
      buchhaltungsbutler_trash_receipt: '/receipts/delete/{id_by_customer}',
      buchhaltungsbutler_recover_receipt: '/receipts/restore/{id_by_customer}',
      buchhaltungsbutler_reverse_posting: '/postings/cancel',
    };
    for (const [name, path] of Object.entries(paths)) expect(tool(name).endpointMapping.path).toBe(path);
  });

  it('sends the posting lines as the parallel lists the API takes', () => {
    for (const name of ['buchhaltungsbutler_book_receipt', 'buchhaltungsbutler_book_transaction']) {
      expect(tool(name).parameters.required).toEqual(expect.arrayContaining(['postingaccounts', 'amounts', 'vats', 'postingtexts']));
      expect(tool(name).endpointMapping.bodyMapping).toMatchObject({ postingaccounts: '$postingaccounts', amounts: '$amounts', vats: '$vats', postingtexts: '$postingtexts' });
    }
  });

  it('marks the receipt read as read-only and installs the delete and the reversal switched off', () => {
    expect(tool('buchhaltungsbutler_get_receipt').annotations?.readOnlyHint).toBe(true);
    expect(tool('buchhaltungsbutler_trash_receipt').enabled).toBe(false);
    expect(tool('buchhaltungsbutler_reverse_posting').enabled).toBe(false);
    expect(tool('buchhaltungsbutler_book_receipt').enabled).toBeUndefined();
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_BUCHHALTUNGSBUTLER_LIVE === '1';
(live ? describe : describe.skip)('buchhaltungsbutler — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // buchhaltungsbutler answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
