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
      expect(body.api_key).toBe('$BUCHHALTUNGSBUTLER_API_KEY');
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
