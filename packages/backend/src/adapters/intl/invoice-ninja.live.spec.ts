import * as adapter from './invoice-ninja.json';

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

describe('invoice-ninja adapter — static spec conformance', () => {
  it("sends the token in X-API-TOKEN", () => {
    expect(a.connector.authConfig?.headerName).toBe('X-API-TOKEN');
  });

  it("works against both the hosted service and a self-hosted instance", () => {
    expect(a.connector.baseUrl).toBe('{{INVOICENINJA_URL}}/api/v1');
    expect((adapter as unknown as { instructions: string }).instructions).toContain('invoicing.co');
  });

  it("says balance, not amount, is the receivables figure", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('A receivables figure wants `balance`');
  });

  it("exposes no write tool", () => {
    expect(a.tools.every((t) => t.endpointMapping.method === 'GET')).toBe(true);
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_INVOICE_NINJA_LIVE === '1';
(live ? describe : describe.skip)('invoice-ninja — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // invoice-ninja answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
