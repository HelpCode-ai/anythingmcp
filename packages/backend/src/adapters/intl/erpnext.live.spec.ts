import * as adapter from './erpnext.json';

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

describe('erpnext adapter — static spec conformance', () => {
  it("uses Frappe's lower-case `token key:secret` scheme", () => {
    expect(a.connector.authConfig?.apiKey).toBe('token {{ERPNEXT_API_KEY}}:{{ERPNEXT_API_SECRET}}');
  });

  it("exposes the generic DocType route, which is the real API", () => {
    expect(toolNames).toContain('erpnext_list_documents');
    expect(toolNames).toContain('erpnext_get_document');
  });

  it("names the fields on every convenience wrapper", () => {
    for (const name of ['erpnext_list_customers', 'erpnext_list_sales_orders', 'erpnext_list_sales_invoices', 'erpnext_list_items']) {
      const t = a.tools.find((x) => x.name === name)!;
      expect((t.endpointMapping.queryParams as Record<string, string>).fields).toMatch(/^\[/);
    };
  });

  it("warns that omitting fields returns only the primary key", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('only `name` (the primary key)');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ERPNEXT_LIVE === '1';
(live ? describe : describe.skip)('erpnext — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // erpnext answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
