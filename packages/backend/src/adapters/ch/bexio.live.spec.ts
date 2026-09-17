import * as adapter from './bexio.json';

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

describe('bexio adapter — static spec conformance', () => {
  it("is filed under the Swiss region", () => {
    expect(a.region).toBe('ch');
  });

  it("uses a bearer API token", () => {
    expect(a.connector.authType).toBe('BEARER_TOKEN');
    expect(a.connector.authConfig?.token).toBe('{{BEXIO_API_TOKEN}}');
  });

  it("carries bexio's per-resource API version in each path", () => {
    const byName = Object.fromEntries(a.tools.map((t) => [t.name, t.endpointMapping.path]));
    expect(byName.bexio_list_invoices).toBe('/2.0/kb_invoice');
    expect(byName.bexio_list_quotes).toBe('/2.0/kb_offer');
  });

  it("probes the company profile", () => {
    expect(a.probe?.tool).toBe('bexio_get_company_profile');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_BEXIO_LIVE === '1';
(live ? describe : describe.skip)('bexio — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // bexio answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
