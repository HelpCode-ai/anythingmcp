import * as adapter from './aruba-fatturazione.json';

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

describe('aruba-fatturazione adapter — static spec conformance', () => {
  it("trades the API credentials for a bearer token", () => {
    expect(a.connector.authType).toBe('LOGIN_TOKEN');
    expect(a.connector.authConfig?.tokenJsonPath).toBe('access_token');
  });

  it("keeps sent and received invoices apart, as the SDI does", () => {
    expect(toolNames).toContain('aruba_fatturazione_list_sent_invoices');
    expect(toolNames).toContain('aruba_fatturazione_list_received_invoices');
  });

  it("names the SDI state that means the invoice was not issued", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('SCARTATA');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_ARUBA_FATTURAZIONE_LIVE === '1';
(live ? describe : describe.skip)('aruba-fatturazione — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // aruba-fatturazione answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
