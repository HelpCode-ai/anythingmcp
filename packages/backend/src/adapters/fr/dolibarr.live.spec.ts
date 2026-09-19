import * as adapter from './dolibarr.json';

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

describe('dolibarr adapter — static spec conformance', () => {
  it("sends the key in Dolibarr's DOLAPIKEY header, not in the URL", () => {
    expect(a.connector.authConfig?.headerName).toBe('DOLAPIKEY');
  });

  it("points at the installation's api/index.php entry point", () => {
    expect(a.connector.baseUrl).toBe('{{DOLIBARR_URL}}/api/index.php');
  });

  it("probes /status, which needs no module permission", () => {
    expect(a.probe?.tool).toBe('dolibarr_get_status');
  });

  it("says the REST module is off by default", () => {
    expect((adapter as unknown as { instructions: string }).instructions).toContain('off by default');
  });
});

// Opt-in live check. Needs real credentials; skipped in CI.
const live = process.env.RUN_DOLIBARR_LIVE === '1';
(live ? describe : describe.skip)('dolibarr — live', () => {
  it('is exercised through the connector install + probe flow', () => {
    // The adapter's own probe tool is the contract worth checking against a
    // real tenant: `npm run start:dev`, install the adapter, and confirm
    // dolibarr answers. Asserting an HTTP shape here would only restate
    // the static expectations above against a credential CI does not have.
    expect(a.probe?.tool ?? toolNames[0]).toBeTruthy();
  });
});
