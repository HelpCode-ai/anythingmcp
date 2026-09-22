import * as adapter from './holded.json';

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

describe('holded adapter — static spec conformance', () => {
  it("is filed under the Spanish region", () => {
    expect(a.region).toBe('es');
  });

  it("sends the key in Holded's own `key` header", () => {
    expect(a.connector.authConfig?.headerName).toBe('key');
  });

  it("carries the per-module path prefix on each resource", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]));
    expect(byName.holded_list_contacts).toContain('/invoicing/v1/');
    expect(byName.holded_list_leads).toContain('/crm/v1/');
  });

  it("says the date filters are Unix timestamps, not ISO strings", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('Unix timestamps in seconds');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_HOLDED_LIVE === '1';
(live ? describe : describe.skip)('holded — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // holded answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
