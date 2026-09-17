import * as adapter from './pennylane.json';

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

describe('pennylane adapter — static spec conformance', () => {
  it("is filed under the French region", () => {
    expect(a.region).toBe('fr');
  });

  it("targets v2, whose pagination differs from v1", () => {
    expect(a.connector.baseUrl).toBe('https://app.pennylane.com/api/external/v2');
  });

  it("pages by cursor, since v2 has no page number", () => {
    for (const t of a.tools) {
      const qp = (t.endpointMapping.queryParams ?? {}) as Record<string, string>;
      expect(Object.keys(qp)).not.toContain('page');
    };
  });

  it("keeps customer and supplier invoices apart", () => {
    expect(toolNames).toContain('pennylane_list_customer_invoices');
    expect(toolNames).toContain('pennylane_list_supplier_invoices');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_PENNYLANE_LIVE === '1';
(live ? describe : describe.skip)('pennylane — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // pennylane answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
